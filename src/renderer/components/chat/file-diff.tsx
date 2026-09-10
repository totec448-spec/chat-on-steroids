import type { FileChange } from '../../../shared/session.js';
import { Icon } from '../ui/icon.js';
import styles from './FileDiff.module.css';

/**
 * Recorded file-change evidence. The recorder currently keeps paths and line counts, not old/new
 * source text, so this deliberately does not manufacture diff hunks or line numbers.
 */
export function FileDiff({ changes }: { changes: readonly FileChange[] }) {
  if (!changes.length) return null;
  const added = changes.reduce((sum, change) => sum + change.added, 0);
  const removed = changes.reduce((sum, change) => sum + change.removed, 0);
  const approximate = changes.some(change => change.approximate);

  return (
    <div className={styles.diff} aria-label="Recorded file changes">
      <div className={styles.diffHead}>
        <span className={styles.diffFileWrap}>
          <Icon name="i-file" className={styles.diffIcon} />
          <span className={styles.diffFile}>{changes.length === 1 ? changes[0]!.path : `${changes.length} files changed`}</span>
        </span>
        <span className={styles.diffStat}>
          <span className={styles.add}>+{added}</span>
          <span className={styles.del}>-{removed}</span>
        </span>
      </div>
      <div className={styles.diffBody}>
        {changes.map(change => (
          <div key={change.path} className={styles.diffRow}>
            <span className={styles.path} title={change.path}>{change.path}</span>
            {change.approximate && <span className={styles.approx}>approx.</span>}
            <span className={styles.rowStat}>
              <span className={styles.add}>+{change.added}</span>
              <span className={styles.del}>-{change.removed}</span>
            </span>
          </div>
        ))}
      </div>
      {approximate && <div className={styles.note}>Some line counts are bounded estimates from the recorded tool result.</div>}
    </div>
  );
}
