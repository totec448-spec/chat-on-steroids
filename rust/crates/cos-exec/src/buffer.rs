// Vendored from openai/codex at 1a4096e273e80da30947e57fdfa45be92858ca91,
// codex-rs/core/src/unified_exec/head_tail_buffer.rs (Apache-2.0, see ../NOTICE).
// Modified: the omission marker is local, `take` was added for the draining poll, and the
// test-only allowances were removed.

use std::collections::VecDeque;

/// One mebibyte, the most output one session keeps unread (`UNIFIED_EXEC_OUTPUT_MAX_BYTES`).
pub(crate) const OUTPUT_MAX_BYTES: usize = 1024 * 1024;

/// What a completed session keeps for an explicit reread (`COMPLETED_EXEC_OUTPUT_BYTES`).
pub(crate) const COMPLETED_OUTPUT_BYTES: usize = 256 * 1024;

pub(crate) fn format_output_omission_marker(omitted_bytes: usize) -> String {
    format!("... {omitted_bytes} bytes omitted ...")
}

/// A capped buffer that preserves a stable prefix ("head") and suffix ("tail"),
/// dropping the middle once it exceeds the configured maximum. The buffer is
/// symmetric meaning 50% of the capacity is allocated to the head and 50% is
/// allocated to the tail.
#[derive(Debug, Default)]
pub(crate) struct HeadTailBuffer<const MAX_BYTES: usize = OUTPUT_MAX_BYTES> {
    head: Vec<u8>,
    tail: VecDeque<u8>,
    omitted_bytes: usize,
}

impl<const MAX_BYTES: usize> HeadTailBuffer<MAX_BYTES> {
    const HEAD_BUDGET: usize = MAX_BYTES / 2;
    const TAIL_BUDGET: usize = MAX_BYTES.saturating_sub(Self::HEAD_BUDGET);

    /// Total bytes currently retained by the buffer (head + tail).
    pub(crate) fn retained_bytes(&self) -> usize {
        self.head.len().saturating_add(self.tail.len())
    }

    /// Total bytes that were dropped from the middle due to the size cap.
    pub(crate) fn omitted_bytes(&self) -> usize {
        self.omitted_bytes
    }

    /// Total bytes observed by the buffer, including bytes omitted by the cap.
    pub(crate) fn total_bytes(&self) -> usize {
        self.retained_bytes().saturating_add(self.omitted_bytes)
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.total_bytes() == 0
    }

    /// Everything held so far, leaving the buffer empty (`std::mem::take` of the shared buffer).
    pub(crate) fn take(&mut self) -> Self {
        std::mem::take(self)
    }

    /// Append a chunk of bytes to the buffer.
    ///
    /// Bytes are first added to the head until the head budget is full; any
    /// remaining bytes are added to the tail, with older tail bytes being
    /// dropped to preserve the tail budget.
    pub(crate) fn push_chunk(&mut self, chunk: &[u8]) {
        let chunk = self.fill_head(chunk);
        self.push_tail(chunk);
    }

    /// Fill the stable prefix and return the bytes that did not fit.
    fn fill_head<'a>(&mut self, chunk: &'a [u8]) -> &'a [u8] {
        let remaining_head = Self::HEAD_BUDGET.saturating_sub(self.head.len());
        // A shorter chunk fits entirely in the head.
        let (chunk_head, chunk_tail) = chunk
            .split_at_checked(remaining_head)
            .unwrap_or((chunk, &[]));
        self.head.extend_from_slice(chunk_head);
        chunk_tail
    }

    /// Append bytes known not to belong in the head, keeping the newest tail bytes.
    fn push_tail(&mut self, chunk: &[u8]) {
        let remaining_tail = Self::TAIL_BUDGET.saturating_sub(self.tail.len());
        let excess_tail = chunk.len().saturating_sub(remaining_tail);
        self.omitted_bytes = self.omitted_bytes.saturating_add(excess_tail);

        // Discard old tail bytes first, then skip any excess incoming bytes.
        let chunk = match excess_tail.checked_sub(self.tail.len()) {
            None => {
                self.tail.drain(..excess_tail);
                chunk
            }
            Some(skip) => {
                self.tail.clear();
                &chunk[skip..]
            }
        };
        self.tail.extend(chunk);
    }

    /// Return the retained output as a single byte vector.
    pub(crate) fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.retained_bytes());
        out.extend_from_slice(&self.head);
        out.extend(self.tail.iter().copied());
        out
    }

    /// Return the retained output with an explicit marker between the head and
    /// tail when bytes were omitted.
    pub(crate) fn to_bytes_with_omission_marker(&self) -> Vec<u8> {
        if self.omitted_bytes == 0 {
            return self.to_bytes();
        }

        let marker = format_output_omission_marker(self.omitted_bytes);
        let mut out = Vec::with_capacity(
            self.retained_bytes()
                .saturating_add(marker.len())
                .saturating_add(2),
        );
        out.extend_from_slice(&self.head);
        out.push(b'\n');
        out.extend_from_slice(marker.as_bytes());
        out.push(b'\n');
        out.extend(self.tail.iter().copied());
        out
    }

    /// Append a later buffer with the same budget. This preserves the summary
    /// of the original concatenated output, including its omission count.
    pub(crate) fn push_buffer(&mut self, buffer: Self) {
        let Self {
            head,
            tail,
            omitted_bytes,
        } = buffer;

        self.omitted_bytes = self.omitted_bytes.saturating_add(omitted_bytes);

        // Preserve an existing prefix; otherwise reuse the source head.
        let overflow = if self.head.is_empty() {
            self.head = head;
            &[][..]
        } else {
            self.fill_head(&head)
        };

        // A full source tail displaces both the old tail and the unused source head.
        if tail.len() == Self::TAIL_BUDGET {
            self.omitted_bytes = self
                .omitted_bytes
                .saturating_add(self.tail.len())
                .saturating_add(overflow.len());
            self.tail = tail;
        } else {
            self.push_tail(overflow);
            // An empty destination can take a partial source tail without copying it.
            if self.tail.is_empty() {
                self.tail = tail;
            } else {
                // A nonempty source tail means its head, and now ours, is full.
                let (first, second) = tail.as_slices();
                self.push_tail(first);
                self.push_tail(second);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_head_and_tail_and_counts_the_middle() {
        let mut buffer = HeadTailBuffer::<10>::default();
        buffer.push_chunk(b"0123456789abcdef");
        assert_eq!(buffer.to_bytes(), b"01234bcdef");
        assert_eq!(buffer.omitted_bytes(), 6);
        assert_eq!(buffer.total_bytes(), 16);
        assert_eq!(
            buffer.to_bytes_with_omission_marker(),
            b"01234\n... 6 bytes omitted ...\nbcdef"
        );
    }

    #[test]
    fn appending_a_buffer_equals_pushing_its_bytes() {
        let mut joined = HeadTailBuffer::<8>::default();
        joined.push_chunk(b"abc");
        let mut later = HeadTailBuffer::<8>::default();
        later.push_chunk(b"defghijklm");
        joined.push_buffer(later);

        let mut direct = HeadTailBuffer::<8>::default();
        direct.push_chunk(b"abcdefghijklm");
        assert_eq!(joined.to_bytes(), direct.to_bytes());
        assert_eq!(joined.total_bytes(), 13);
    }
}
