/* 全局快捷键：四个窗口都能收到焦点，所以每个窗口都要挂一份。 */
(function () {
  window.bindHotkeys = function (options) {
    const opts = options || {};
    window.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      const tag = (e.target && e.target.tagName) || '';
      const typing = tag === 'INPUT' || tag === 'TEXTAREA';

      if (mod && !e.altKey && (e.key === 'b' || e.key === 'B')) {
        window.aqua.send('sidebar:toggle');
        e.preventDefault();
        return;
      }
      if (mod && !e.altKey && (e.key === 'p' || e.key === 'P')) {
        window.aqua.send('win:pip');
        e.preventDefault();
        return;
      }
      if (mod && !e.altKey && (e.key === 'o' || e.key === 'O')) {
        window.aqua.invoke('library:pick');
        e.preventDefault();
        return;
      }
      if (mod && e.altKey && (e.key === 's' || e.key === 'S')) {
        window.aqua.send('sidebar:layout', 'push');
        e.preventDefault();
        return;
      }
      if (e.key === '\\' && mod) {
        window.aqua.send('sidebar:toggle');
        e.preventDefault();
        return;
      }
      if (typing) return;

      switch (e.key) {
        case ' ':
          window.aqua.send('play:toggle');
          e.preventDefault();
          break;
        case 'ArrowLeft':
          if (mod) window.aqua.send('play:prev');
          else window.aqua.send('play:offset', -5);
          e.preventDefault();
          break;
        case 'ArrowRight':
          if (mod) window.aqua.send('play:next');
          else window.aqua.send('play:offset', 5);
          e.preventDefault();
          break;
        case 'ArrowUp':
          window.aqua.send('play:volume', (opts.getVolume ? opts.getVolume() : 70) + 5);
          e.preventDefault();
          break;
        case 'ArrowDown':
          window.aqua.send('play:volume', (opts.getVolume ? opts.getVolume() : 70) - 5);
          e.preventDefault();
          break;
        case 'f':
        case 'F':
          window.aqua.send('win', 'fullscreen');
          e.preventDefault();
          break;
        case '[':
          window.aqua.send('play:speed', Math.max(0.25, (opts.getSpeed ? opts.getSpeed() : 1) - 0.25));
          e.preventDefault();
          break;
        case ']':
          window.aqua.send('play:speed', Math.min(4, (opts.getSpeed ? opts.getSpeed() : 1) + 0.25));
          e.preventDefault();
          break;
        case '\\':
          if (!mod) window.aqua.send('play:speed', 1);
          break;
        case 'Escape':
          if (opts.onEscape) opts.onEscape();
          break;
        default:
          break;
      }
    });
  };
})();
