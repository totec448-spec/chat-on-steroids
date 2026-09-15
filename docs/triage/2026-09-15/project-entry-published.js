  function projectHomeId(pathname = location.pathname) {
    return /^\/g\/(g-p-[0-9a-f]{32})(?:-[^/]+)?\/project\/?$/i.exec(pathname)?.[1]?.toLowerCase() || null;
  }

  /** Enter a Project through its source chat's native link. Cold /project loads can error. */
  async function enterProject(entry, stillCurrent = () => true) {
    if (!entry || !/^g-p-[0-9a-f]{32}$/.test(entry.id) || conversationId() !== entry.sourceConversationId) return false;
    return new Promise(resolve => {
      let clicked = false, done = false, sourceComposer = null;
      const interrupt = event => { if (event.isTrusted) finish(false); };
      const finish = result => {
        if (done) return;
        done = true; observer.disconnect(); clearTimeout(timer);
        document.removeEventListener('pointerdown', interrupt, true);
        document.removeEventListener('keydown', interrupt, true);
        resolve(result);
      };
      const check = () => {
        if (done) return;
        if (!stillCurrent()) return finish(false);
        if (clicked && projectHomeId() === entry.id && composer()?.isConnected && composer() !== sourceComposer && !turns().length) return finish(true);
        if (conversationId() !== entry.sourceConversationId) {
          if (projectHomeId() !== entry.id) finish(false);
          return;
        }
        if (clicked) return;
        // The native header arrives before the source chat finishes loading. Its link
        // alone is not readiness: an early click can be swallowed during hydration and
        // would also leave us comparing the destination editor with a null source.
        // Preserve the source draft/generation and spend our one click only once its
        // actual editor is mounted and ready.
        const source = composer();
        if (!source?.isConnected || !composerSubmitReady() || hasComposerAttachments()) return;
        const links = [...document.querySelectorAll('header a[href], [role="banner"] a[href]')].filter(link =>
          link.querySelector('[data-testid="project-folder-icon"]') && !link.closest(OWN_SURFACES) &&
          new URL(link.href, location.href).origin === location.origin && projectHomeId(new URL(link.href, location.href).pathname) === entry.id);
        if (links.length !== 1) return;
        sourceComposer = source;
        clicked = true;
        // Loading the source and following its link are separate page transitions.
        // Reuse the same deadline timer; source loading must not consume the budget
        // for observing the replacement editor after the one permitted click.
        clearTimeout(timer);
        timer = setTimeout(() => finish(false), 12_000);
        links[0].click();
        check();
      };
      const observer = new MutationObserver(check);
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
      let timer = setTimeout(() => finish(false), 12_000);
      document.addEventListener('pointerdown', interrupt, true);
      document.addEventListener('keydown', interrupt, true);
      check();
    });
  }
