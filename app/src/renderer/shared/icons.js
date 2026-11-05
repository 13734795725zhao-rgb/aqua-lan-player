/* SF Symbols 风格的极简图标（24x24，统一 currentColor 描边/填充）。 */
(function () {
  const ICONS = {
    folder: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.1c.7 0 1.35.3 1.8.82L11.5 7H18a2.5 2.5 0 0 1 2.5 2.5v7A2.5 2.5 0 0 1 18 19H5.5A2.5 2.5 0 0 1 3 16.5z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
    search: '<circle cx="10.5" cy="10.5" r="5.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M14.8 14.8 19.5 19.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
    close: '<path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    chevronRight: '<path d="M9.5 5.5 16 12l-6.5 6.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
    sidebarRight: '<rect x="3" y="4.5" width="18" height="15" rx="3" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M14.5 4.5v15" stroke="currentColor" stroke-width="1.6"/>',
    push: '<rect x="3" y="4.5" width="18" height="15" rx="3" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M15 9.5 17.5 12 15 14.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
    overlay: '<rect x="3" y="4.5" width="18" height="15" rx="3" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="13.5" y="6.5" width="6" height="11" rx="1.5" fill="currentColor" opacity=".85"/>',
    pin: '<path d="M12 3.5a5.5 5.5 0 0 1 5.5 5.5c0 2.6-1.6 4.2-3 5.6l-.2.9H9.7l-.2-.9C8.1 13.2 6.5 11.6 6.5 9A5.5 5.5 0 0 1 12 3.5z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M12 15.5V20" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    play: '<path d="M8 5.2v13.6L19 12z" fill="currentColor"/>',
    pause: '<rect x="7.5" y="5.5" width="3.4" height="13" rx="1.2" fill="currentColor"/><rect x="13.1" y="5.5" width="3.4" height="13" rx="1.2" fill="currentColor"/>',
    backward: '<path d="M11 7.5v9L4 12z" fill="currentColor"/><path d="M20 7.5v9l-7-4.5z" fill="currentColor"/>',
    forward: '<path d="M13 7.5v9l7-4.5z" fill="currentColor"/><path d="M4 7.5v9l7-4.5z" fill="currentColor"/>',
    speaker: '<path d="M4 9.5h3L11.5 6v12L7 14.5H4z" fill="currentColor"/><path d="M15 9.2a4 4 0 0 1 0 5.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M17.8 6.8a7.2 7.2 0 0 1 0 10.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    speakerMute: '<path d="M4 9.5h3L11.5 6v12L7 14.5H4z" fill="currentColor"/><path d="M15.5 9.5l5 5M20.5 9.5l-5 5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
    fullscreen: '<path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
    exitFullscreen: '<path d="M9 4v3.5A1.5 1.5 0 0 1 7.5 9H4M20 9h-3.5A1.5 1.5 0 0 1 15 7.5V4M15 20v-3.5a1.5 1.5 0 0 1 1.5-1.5H20M4 15h3.5A1.5 1.5 0 0 1 9 16.5V20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
    // SF Symbols: gobackward.10 / goforward.10 —— 环形箭头 + 秒数，一眼看出步长
    backward10: '<path d="M12 6.6A6.6 6.6 0 1 1 5.4 13.2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M9.2 6.4 12.4 5.6l.7 3.2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><text x="12" y="16.4" text-anchor="middle" font-size="7" font-weight="700" fill="currentColor">10</text>',
    forward10: '<path d="M12 6.6A6.6 6.6 0 1 0 18.6 13.2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M14.8 6.4 11.6 5.6l-.7 3.2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><text x="12" y="16.4" text-anchor="middle" font-size="7" font-weight="700" fill="currentColor">10</text>',
    video: '<rect x="3" y="5.5" width="18" height="13" rx="3" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".9"/><path d="M10.5 9.5v5l4-2.5z" fill="currentColor" opacity=".9"/>',
    // 画中画：外框 + 右下角小窗（pip.enter / pip.exit）
    pip: '<rect x="3" y="5" width="18" height="14" rx="3" fill="none" stroke="currentColor" stroke-width="1.7"/><rect x="11" y="12" width="8" height="5.5" rx="1.4" fill="currentColor"/>',
    pipExit: '<rect x="3" y="5" width="18" height="14" rx="3" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M11 15.5h2.6v-3.6H15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M13.3 14.6 11.4 12.4l1.9-2.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
    // 倍速表盘（gauge）
    gauge: '<path d="M4.6 16.4a8 8 0 1 1 14.8 0" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M12 13.2 15.4 9.6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="12" cy="16.6" r="1.4" fill="currentColor"/>',
    check: '<path d="M5 12.8 9.6 17.4 19 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    chevronDown: '<path d="M6 9.5 12 15l6-5.5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>',
    sort: '<path d="M7 4v16m0 0-3-3m3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M17 20V4m0 0-3 3m3-3 3 3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
    sliders: '<path d="M4 8h10M18 8h2M4 16h4M12 16h8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="16" cy="8" r="2.1" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="10" cy="16" r="2.1" fill="none" stroke="currentColor" stroke-width="1.7"/>',
    text: '<path d="M5 6.5V5h14v1.5M12 5v14M9 19h6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
    list: '<path d="M4 6.5h16M4 12h16M4 17.5h16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
    sequence: '<path d="M4 6.5h9M4 12h9M4 17.5h9" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M16 8.5v7M16 15.5l3-3M16 15.5l-3-3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
    loop: '<path d="M17 3.5 20.5 7 17 10.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M20 7H8a4 4 0 0 0-4 4v1" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M7 20.5 3.5 17 7 13.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 17h12a4 4 0 0 0 4-4v-1" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
    shuffle: '<path d="M4 6.5h3.5c1.4 0 2.4.7 3.3 1.8l3.4 4.4c.9 1.1 1.9 1.8 3.3 1.8H20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M4 17.5h3.5c1.4 0 2.4-.7 3.3-1.8l.8-1M14 9.3l1-1.3c.9-1.1 1.9-1.8 3.3-1.8H20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M17.5 4 20.5 6.5 17.5 9M17.5 15 20.5 17.5 17.5 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
    playMode: '<path d="M4 6.5h16M4 12h16M4 17.5h16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M10 9.5v5l4-2.5z" fill="currentColor"/>',
    warning: '<path d="M12 4.5 21 19.5H3z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M12 10v4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="12" cy="16.8" r="1" fill="currentColor"/>',
    refresh: '<path d="M19 12a7 7 0 1 1-2.6-5.45" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M19 4.5V9h-4.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
  };

  window.icon = function (name) {
    const body = ICONS[name] || '';
    return '<svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true">' + body + '</svg>';
  };
})();
