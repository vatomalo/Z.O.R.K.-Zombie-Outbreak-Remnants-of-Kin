(() => {
  const state = {
    enabled: null,
    tx: 0,
    ty: 0,
    zoom: 1,
    smoothing: 0.16,
    storageKey: 'zork.mobileFollowCamera.enabled',
    button: null,
    style: null,
  };

  function isTouchLike() {
    return window.matchMedia?.('(pointer: coarse) and (hover: none)')?.matches || window.innerWidth <= 820;
  }

  function isPortrait() {
    return window.matchMedia?.('(orientation: portrait)')?.matches || window.innerHeight >= window.innerWidth;
  }

  function getEnabledDefault() {
    return isTouchLike();
  }

  function loadEnabled() {
    const stored = localStorage.getItem(state.storageKey);
    state.enabled = stored === null ? getEnabledDefault() : stored === 'true';
  }

  function saveEnabled() {
    localStorage.setItem(state.storageKey, String(state.enabled));
  }

  function resetCanvas() {
    const canvas = document.getElementById('render-canvas');
    if (!canvas) return;
    canvas.style.transform = '';
    canvas.style.transformOrigin = '';
    canvas.style.willChange = '';
    state.tx = 0;
    state.ty = 0;
  }

  function updateButton() {
    if (!state.button) return;
    state.button.textContent = state.enabled ? 'CAM ON' : 'CAM OFF';
    state.button.classList.toggle('is-on', state.enabled);
    state.button.setAttribute('aria-pressed', String(state.enabled));
  }

  function setEnabled(value) {
    state.enabled = Boolean(value);
    saveEnabled();
    updateButton();
    if (!state.enabled) resetCanvas();
  }

  function injectStyles() {
    if (state.style || !document.head) return;
    const style = document.createElement('style');
    style.id = 'zork-follow-camera-style';
    style.textContent = `
      #zork-camera-toggle {
        position: fixed;
        z-index: 80;
        right: max(8px, env(safe-area-inset-right, 0px));
        top: max(8px, env(safe-area-inset-top, 0px));
        min-width: 72px;
        min-height: 34px;
        padding: 6px 9px;
        border: 1px solid rgba(232, 224, 209, 0.48);
        border-radius: 0;
        background: rgba(3, 3, 3, 0.82);
        color: #e8e0d1;
        font-family: 'Lucida Console', Monaco, 'Courier New', monospace;
        font-size: 11px;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        box-shadow: inset -2px -2px 0 rgba(0,0,0,.72), inset 1px 1px 0 rgba(255,255,255,.08);
        touch-action: manipulation;
      }
      #zork-camera-toggle.is-on {
        background: rgba(85, 22, 20, 0.9);
        border-color: rgba(255, 218, 180, 0.72);
      }
      @media (min-width: 821px) and (hover: hover) and (pointer: fine) {
        #zork-camera-toggle { display: none; }
      }
    `;
    document.head.appendChild(style);
    state.style = style;
  }

  function createButton() {
    if (state.button || !document.body) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.id = 'zork-camera-toggle';
    button.title = 'Toggle mobile follow camera';
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      setEnabled(!state.enabled);
    });
    document.body.appendChild(button);
    state.button = button;
    updateButton();
  }

  function getPlayerScreenPoint(canvas, camera, character) {
    if (!camera || !character?.position?.clone) return null;
    const point = character.position.clone();
    point.y += 0.9;
    point.project(camera);
    const rect = canvas.getBoundingClientRect();
    return {
      rect,
      x: (point.x * 0.5 + 0.5) * rect.width,
      y: (-point.y * 0.5 + 0.5) * rect.height,
    };
  }

  function applyFollow() {
    const canvas = document.getElementById('render-canvas');
    const room = window.RoomManager;
    const camera = room?.currentRoom?.camera;
    const character = room?.character;

    if (!canvas || !room || !camera || !character || room.cinematicActive || !isTouchLike()) {
      if (!state.enabled) resetCanvas();
      return;
    }

    if (!state.enabled) {
      resetCanvas();
      return;
    }

    const data = getPlayerScreenPoint(canvas, camera, character);
    if (!data?.rect?.width || !data?.rect?.height) return;

    const portrait = isPortrait();
    const scale = portrait ? 1.55 : 1.28;
    state.zoom = scale;

    const focusX = data.rect.width * (portrait ? 0.5 : 0.43);
    const focusY = data.rect.height * (portrait ? 0.42 : 0.5);
    let targetTx = focusX - data.x * scale;
    let targetTy = focusY - data.y * scale;

    const minTx = data.rect.width - data.rect.width * scale;
    const minTy = data.rect.height - data.rect.height * scale;
    targetTx = Math.min(0, Math.max(minTx, targetTx));
    targetTy = Math.min(0, Math.max(minTy, targetTy));

    state.tx += (targetTx - state.tx) * state.smoothing;
    state.ty += (targetTy - state.ty) * state.smoothing;

    canvas.style.transformOrigin = '0 0';
    canvas.style.willChange = 'transform';
    canvas.style.transform = `translate3d(${state.tx.toFixed(2)}px, ${state.ty.toFixed(2)}px, 0) scale(${scale})`;
  }

  function init() {
    if (state.enabled === null) loadEnabled();
    injectStyles();
    createButton();
    window.ZORK_CAMERA_FOLLOW = {
      enable: () => setEnabled(true),
      disable: () => setEnabled(false),
      toggle: () => setEnabled(!state.enabled),
      setEnabled: (value) => setEnabled(value),
      getState: () => ({ enabled: state.enabled, zoom: state.zoom, tx: state.tx, ty: state.ty }),
    };
  }

  function tick() {
    init();
    applyFollow();
    requestAnimationFrame(tick);
  }

  tick();
})();
