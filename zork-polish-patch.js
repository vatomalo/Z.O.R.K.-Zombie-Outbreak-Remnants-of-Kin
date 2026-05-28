(() => {
  const textRules = [
    [/Romeo's/g, 'my'],
    [/Romeo is/g, 'I am'],
    [/Romeo has/g, 'I have'],
    [/Romeo goes/g, 'I go'],
    [/Romeo gets/g, 'I get'],
    [/Romeo heads/g, 'I head'],
    [/Romeo follows/g, 'I follow'],
    [/Romeo slips/g, 'I slip'],
    [/Romeo opens/g, 'I open'],
    [/Romeo takes/g, 'I take'],
    [/Romeo pockets/g, 'I pocket'],
    [/Romeo lifts/g, 'I lift'],
    [/Romeo carries/g, 'I carry'],
    [/Romeo lowers/g, 'I lower'],
    [/Romeo stays/g, 'I stay'],
    [/Romeo remembers/g, 'I remember'],
    [/Romeo looks/g, 'I look'],
    [/Romeo cannot/g, 'I cannot'],
    [/Romeo can/g, 'I can'],
    [/Romeo decides/g, 'I decide'],
    [/Romeo studies/g, 'I study'],
    [/Romeo waits/g, 'I wait'],
    [/Romeo reaches/g, 'I reach'],
    [/Romeo/g, 'I'],
  ];

  function zorkText(text) {
    if (typeof text !== 'string') return text;
    let result = text;
    for (const [pattern, replacement] of textRules) {
      result = result.replace(pattern, replacement);
    }
    return result
      .replace(/I has/g, 'I have')
      .replace(/I is/g, 'I am')
      .replace(/I gets/g, 'I get')
      .replace(/I goes/g, 'I go')
      .replace(/I slips/g, 'I slip')
      .replace(/I opens/g, 'I open')
      .replace(/I takes/g, 'I take')
      .replace(/I studies/g, 'I study')
      .replace(/I decides/g, 'I decide')
      .replace(/I's/g, 'my');
  }

  function patchNarrator() {
    const narrator = window.NarratorVoice;
    if (!narrator || narrator.__zorkPolished) return false;
    narrator.__zorkPolished = true;

    const originalSpeak = narrator.speak.bind(narrator);
    const originalAmbient = narrator.setAmbientText.bind(narrator);
    const originalInstant = narrator.setInstantText.bind(narrator);

    narrator.speak = (message, choices = [], options = {}) => originalSpeak(zorkText(message), choices, options);
    narrator.setAmbientText = (message) => originalAmbient(zorkText(message));
    narrator.setInstantText = (message) => originalInstant(zorkText(message));
    return true;
  }

  function polishDriveSequence(sequence = {}) {
    if (!sequence || typeof sequence !== 'object') return sequence;
    const startsOnStreet = sequence.firstRoom === 'street' || !sequence.firstRoom;
    const goesDowntown = sequence.secondRoom === 'street_to_downtown' || sequence.secondSpawn === 'from_garage' || sequence.secondSpawn === 'from_street';
    if (!startsOnStreet || !goesDowntown) return sequence;

    return {
      ...sequence,
      vanishingPoint: sequence.vanishingPoint === '58% 44%' || !sequence.vanishingPoint ? '62% 44%' : sequence.vanishingPoint,
      firstPersonZoomScale: Math.min(sequence.firstPersonZoomScale ?? 1.92, 1.92),
      carStartX: Math.max(sequence.carStartX ?? -2.15, -2.15),
      carHoldX: Math.max(sequence.carHoldX ?? -0.85, -0.85),
      carEndX: Math.max(sequence.carEndX ?? 0.45, 0.45),
      carZ: Number.isFinite(sequence.carZ) ? Math.min(sequence.carZ, -2.55) : -2.55,
      afterText: sequence.afterText ? zorkText(sequence.afterText) : 'The next block moves past in wet slices of light. I keep both hands on the wheel.',
    };
  }

  function patchDriveSequence() {
    const room = window.RoomManager;
    if (!room || room.__zorkDrivePolished || typeof room.playDriveSequence !== 'function') return false;
    room.__zorkDrivePolished = true;
    const originalDrive = room.playDriveSequence.bind(room);
    room.playDriveSequence = (sequence = {}, action = {}) => originalDrive(polishDriveSequence(sequence), action);
    return true;
  }

  function patchMovementAnimation() {
    const room = window.RoomManager;
    const app = window.App;
    const animator = room?.characterAnimator;
    const movement = app?.movement;
    const currentName = animator?.currentName;
    const action = animator?.currentAction;
    if (!animator || !action || !movement || !currentName) return;

    const fastMultiplier = (movement.path?.length || movement.targetPosition) ? (movement.pathSpeedMultiplier || 1) : 1;
    const locomotion = ['walk', 'backpedal', 'carry_walk'];
    if (!locomotion.includes(currentName)) return;

    const base = room.characterAnimationSpeeds?.[currentName] || 1;
    const carryPenalty = currentName === 'carry_walk' ? 0.92 : 1;
    action.setEffectiveTimeScale(base * fastMultiplier * carryPenalty);
  }

  function tick() {
    patchNarrator();
    patchDriveSequence();
    patchMovementAnimation();
    requestAnimationFrame(tick);
  }

  tick();
})();
