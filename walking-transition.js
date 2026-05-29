(() => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

  function getRoomBackgroundSrc() {
    const room = window.RoomManager;
    const source = room?.hybridRoomData?.hybrid3d?.layers?.background || room?.hybridRoomData?.layers?.background;
    if (!source) return null;
    return room.getRoomAssetPath?.(room.hybridRoomData, source) || source;
  }

  function getSceneRect() {
    const canvas = document.getElementById('render-canvas');
    return canvas?.getBoundingClientRect?.() || { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  }

  function setParkedCarVisible(visible) {
    const room = window.RoomManager;
    const roomId = room?.hybridRoomData?.id || room?.currentRoom?.roomData?.id;
    const car = room?.getPlacedModel?.('escape_car', roomId);
    if (car) car.visible = visible;
  }

  function activateSwarm() {
    const room = window.RoomManager;
    const threat = window.ThreatManager;
    const ids = ['swarm_left', 'swarm_center_far', 'swarm_right_near', 'swarm_back_left', 'swarm_back_right'];
    ids.forEach((id) => room?.setActorActive?.(id, true));
    threat?.alertRoom?.('downtown_swarm', 'danger');
  }

  async function playWalkingOverlay() {
    const imageSrc = getRoomBackgroundSrc();
    const rect = getSceneRect();
    const overlay = document.createElement('div');
    overlay.className = 'zork-walk-transition';
    overlay.style.left = `${rect.left}px`;
    overlay.style.top = `${rect.top}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;

    const layerA = document.createElement('div');
    const layerB = document.createElement('div');
    layerA.className = 'zork-walk-transition-layer zork-walk-transition-layer-a';
    layerB.className = 'zork-walk-transition-layer zork-walk-transition-layer-b';
    if (imageSrc) {
      layerA.style.backgroundImage = `url("${imageSrc}")`;
      layerB.style.backgroundImage = `url("${imageSrc}")`;
    }

    const shadow = document.createElement('div');
    shadow.className = 'zork-walk-transition-shadow';
    const footfall = document.createElement('div');
    footfall.className = 'zork-walk-transition-footfall';
    footfall.textContent = 'WALKING DEEPER';

    overlay.appendChild(layerA);
    overlay.appendChild(layerB);
    overlay.appendChild(shadow);
    overlay.appendChild(footfall);
    document.body.appendChild(overlay);

    await nextFrame();
    overlay.classList.add('is-moving');
    await wait(1450);
    overlay.classList.add('is-ending');
    await wait(360);
    overlay.remove();
  }

  async function walkToDowntownSwarm() {
    const interaction = window.InteractionEngine;
    const game = window.GameState;
    const narrator = window.NarratorVoice;
    if (!game || !interaction) return;
    if (window.__zorkWalkingTransitionActive) return;
    window.__zorkWalkingTransitionActive = true;

    try {
      narrator?.setAmbientText?.('I leave the parked car behind and follow the block on foot. The rain starts sounding like footsteps.');
      window.App?.movement?.clearTarget?.();
      setParkedCarVisible(false);
      await playWalkingOverlay();
      game.setRoom('downtown_swarm', 'from_parked_car');
      await nextFrame();
      activateSwarm();
      narrator?.setAmbientText?.('The street is empty for half a second. Then the bodies remember where I am.');
    } finally {
      window.__zorkWalkingTransitionActive = false;
    }
  }

  function injectStyles() {
    if (document.getElementById('zork-walking-transition-style')) return;
    const style = document.createElement('style');
    style.id = 'zork-walking-transition-style';
    style.textContent = `
      .zork-walk-transition {
        position: fixed;
        z-index: 70;
        overflow: hidden;
        pointer-events: none;
        background: #000;
        box-shadow: inset 0 0 80px rgba(0,0,0,.92);
      }
      .zork-walk-transition-layer {
        position: absolute;
        inset: -6% -20%;
        background-size: cover;
        background-position: 50% 50%;
        background-repeat: repeat-x;
        filter: contrast(1.08) brightness(.74) saturate(.84);
        transform: translate3d(0,0,0) scale(1.08);
        opacity: .96;
        will-change: transform, opacity;
      }
      .zork-walk-transition-layer-b {
        opacity: .34;
        mix-blend-mode: screen;
        filter: blur(1px) contrast(1.18) brightness(.48);
      }
      .zork-walk-transition.is-moving .zork-walk-transition-layer-a {
        animation: zorkWalkPan 1450ms cubic-bezier(.18,.66,.24,1) forwards;
      }
      .zork-walk-transition.is-moving .zork-walk-transition-layer-b {
        animation: zorkWalkPanGhost 1450ms cubic-bezier(.18,.66,.24,1) forwards;
      }
      .zork-walk-transition-shadow {
        position: absolute;
        inset: 0;
        background:
          radial-gradient(circle at 50% 58%, transparent 0 34%, rgba(0,0,0,.36) 58%, rgba(0,0,0,.82) 100%),
          linear-gradient(180deg, rgba(0,0,0,.3), transparent 35%, rgba(0,0,0,.42));
      }
      .zork-walk-transition-footfall {
        position: absolute;
        left: 50%;
        bottom: 22px;
        transform: translateX(-50%);
        padding: 5px 9px;
        border: 1px solid rgba(232,224,209,.26);
        background: rgba(0,0,0,.62);
        color: rgba(232,224,209,.78);
        font-family: 'Lucida Console', Monaco, 'Courier New', monospace;
        font-size: 10px;
        letter-spacing: .18em;
      }
      .zork-walk-transition.is-moving .zork-walk-transition-footfall {
        animation: zorkFootfall 320ms steps(2, end) infinite;
      }
      .zork-walk-transition.is-ending {
        opacity: 0;
        transition: opacity 340ms ease-in;
      }
      @keyframes zorkWalkPan {
        0% { transform: translate3d(0,0,0) scale(1.08); }
        38% { transform: translate3d(-5.5%, 1.2%, 0) scale(1.18); }
        70% { transform: translate3d(-10%, -0.4%, 0) scale(1.24); }
        100% { transform: translate3d(-16%, 0, 0) scale(1.32); }
      }
      @keyframes zorkWalkPanGhost {
        0% { transform: translate3d(0,0,0) scale(1.12); }
        100% { transform: translate3d(-24%, 0, 0) scale(1.38); }
      }
      @keyframes zorkFootfall {
        0% { opacity: .5; transform: translateX(-50%) translateY(0); }
        50% { opacity: 1; transform: translateX(-50%) translateY(1px); }
        100% { opacity: .62; transform: translateX(-50%) translateY(0); }
      }
    `;
    document.head.appendChild(style);
  }

  function patchInteraction() {
    const interaction = window.InteractionEngine;
    if (!interaction || interaction.__zorkWalkingTransitionPatched) return false;
    interaction.__zorkWalkingTransitionPatched = true;
    interaction.listeners.walkToDowntownSwarm = walkToDowntownSwarm;
    return true;
  }

  function tick() {
    injectStyles();
    patchInteraction();
    requestAnimationFrame(tick);
  }

  tick();
})();
