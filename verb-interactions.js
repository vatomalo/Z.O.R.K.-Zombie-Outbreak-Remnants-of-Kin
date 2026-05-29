(() => {
  const state = {
    selectedItemId: null,
    patched: false,
  };

  function getVerb() {
    return window.ZORK_VERB_UI?.getVerb?.() || window.ZORK_VERB || 'use';
  }

  function setVerb(verb) {
    if (window.ZORK_VERB_UI?.setVerb) window.ZORK_VERB_UI.setVerb(verb);
    else window.ZORK_VERB = verb;
  }

  function getInventoryItem(itemId = state.selectedItemId) {
    if (!itemId) return null;
    return window.GameState?.player?.inventory?.find((item) => item?.id === itemId) || null;
  }

  function getSelectedItem() {
    return getInventoryItem(state.selectedItemId);
  }

  function getItemName(itemId = state.selectedItemId) {
    const item = getInventoryItem(itemId);
    return item?.name || itemId?.replaceAll?.('_', ' ') || 'item';
  }

  function setSelectedItem(itemId) {
    state.selectedItemId = itemId || null;
    window.ZORK_SELECTED_ITEM = state.selectedItemId;
    if (state.selectedItemId) setVerb('use');
    updateInventorySelection();
    updateVerbReadout();
  }

  function clearSelectedItem() {
    setSelectedItem(null);
  }

  function say(text) {
    window.NarratorVoice?.speak?.(text, [{ label: 'Continue', action: () => {} }]);
  }

  function ambient(text) {
    window.NarratorVoice?.setAmbientText?.(text);
  }

  function titleForVerb(verb) {
    if (verb === 'look') return 'Look At';
    if (verb === 'pickup') return 'Pick Up';
    return 'Use';
  }

  function targetName(interest = {}) {
    return interest.label || interest.id?.replaceAll?.('_', ' ') || 'that';
  }

  function normalizeVerbEntry(entry) {
    if (!entry) return null;
    if (typeof entry === 'string') return { text: entry };
    if (typeof entry === 'object') return entry;
    return null;
  }

  function getVerbEntry(interest, verb) {
    const verbs = interest?.verbs || interest?.verb || null;
    return normalizeVerbEntry(verbs?.[verb]);
  }

  function getItemAction(useEntry, itemId) {
    if (!useEntry || !itemId) return null;
    const tables = [useEntry.withItem, useEntry.useWith, useEntry.items, useEntry.with];
    for (const table of tables) {
      if (table && typeof table === 'object' && table[itemId]) return normalizeVerbEntry(table[itemId]);
    }
    return null;
  }

  function runAction(action, interest = {}) {
    const engine = window.InteractionEngine;
    if (!engine) return false;
    if (typeof action === 'string') {
      engine.process(action, interest);
      return true;
    }
    if (action && typeof action === 'object') {
      engine.runAction(action, interest);
      return true;
    }
    return false;
  }

  function handleLook(interest) {
    const entry = getVerbEntry(interest, 'look');
    if (entry) return runAction(entry, interest);
    if (interest.lookText) return say(interest.lookText);
    if (interest.text) return say(interest.text);
    return say(`I look at ${targetName(interest)}. Nothing useful jumps out.`);
  }

  function handlePickup(interest) {
    const entry = getVerbEntry(interest, 'pickup') || getVerbEntry(interest, 'pickUp') || getVerbEntry(interest, 'take');
    if (entry) return runAction(entry, interest);

    const pickupValue = interest.pickup ?? interest.pickUp ?? interest.canPickup ?? interest.take;
    const itemId = interest.itemId || interest.item || interest.pickupItem || interest.giveItem;
    const pickupAction = interest.pickupAction || interest.takeAction;

    if (pickupAction) return runAction(pickupAction, interest);
    if (pickupValue || itemId || interest.giveItem) {
      const action = {
        once: interest.once || `pickup.${window.RoomManager?.hybridRoomData?.id || 'room'}.${interest.id || itemId}`,
        giveItem: itemId,
        text: interest.pickupText || interest.takeText || interest.text || `I pick up ${targetName(interest)}.`,
        repeatText: interest.repeatText || `I already took ${targetName(interest)}.`,
      };
      return runAction(action, interest);
    }

    return say(`I am not picking up ${targetName(interest)}. Some things are scenery, some things are traps, and some things are both.`);
  }

  function handleUse(interest, originalProcessInterest) {
    const selectedItem = getSelectedItem();
    const selectedItemId = selectedItem?.id || null;
    const useEntry = getVerbEntry(interest, 'use') || normalizeVerbEntry(interest.use);

    if (selectedItemId) {
      const itemAction = getItemAction(useEntry, selectedItemId)
        || getItemAction(interest, selectedItemId)
        || getItemAction({ withItem: interest.withItem, useWith: interest.useWith }, selectedItemId);

      if (itemAction) {
        clearSelectedItem();
        return runAction(itemAction, interest);
      }

      if (selectedItemId === 'gasoline_can' && (interest.action === 'useGasolineOnCar' || interest.id === 'fuel_cap')) {
        clearSelectedItem();
        return runAction('useGasolineOnCar', interest);
      }

      return say(`I try using ${getItemName(selectedItemId)} on ${targetName(interest)}. No. That is not the move.`);
    }

    if (useEntry) {
      const asksForItem = useEntry.requiresSelectedItem || useEntry.needItem || useEntry.withItem || useEntry.useWith || useEntry.items || useEntry.with;
      if (asksForItem) return say(useEntry.noItemText || useEntry.text || `Use what on ${targetName(interest)}?`);
      return runAction(useEntry, interest);
    }

    if (interest.action === 'useGasolineOnCar' || interest.id === 'fuel_cap') {
      return say('Use what on the fuel cap? The gasoline can is the obvious answer, but obvious still has to be done.');
    }

    return originalProcessInterest(interest);
  }

  function handleVerbInteraction(interest, originalProcessInterest) {
    const verb = getVerb();
    if (verb === 'look') return handleLook(interest);
    if (verb === 'pickup') return handlePickup(interest);
    return handleUse(interest, originalProcessInterest);
  }

  function updateInventorySelection() {
    const slots = document.querySelectorAll('#inventory-grid .inventory-slot');
    slots.forEach((slot, index) => {
      const item = window.GameState?.player?.inventory?.[index] || null;
      slot.classList.toggle('is-selected-item', Boolean(item?.id && item.id === state.selectedItemId));
      if (item?.id) {
        slot.dataset.itemId = item.id;
        slot.setAttribute('role', 'button');
        slot.tabIndex = 0;
      } else {
        delete slot.dataset.itemId;
        slot.removeAttribute('role');
        slot.removeAttribute('tabindex');
      }
    });
  }

  function updateVerbReadout() {
    const label = document.getElementById('selected-verb-label');
    if (!label) return;
    const verb = getVerb();
    const item = getSelectedItem();
    label.textContent = item && verb === 'use'
      ? `Use ${item.name || item.id}`
      : titleForVerb(verb);
  }

  function bindInventorySelection() {
    const grid = document.getElementById('inventory-grid');
    if (!grid || grid.__zorkVerbInventoryBound) return;
    grid.__zorkVerbInventoryBound = true;

    const chooseFromSlot = (slot) => {
      const index = [...grid.children].indexOf(slot);
      const item = window.GameState?.player?.inventory?.[index] || null;
      if (!item) return;
      setSelectedItem(state.selectedItemId === item.id ? null : item.id);
      if (state.selectedItemId) ambient(`Use ${item.name || item.id} with what?`);
    };

    grid.addEventListener('click', (event) => {
      const slot = event.target.closest?.('.inventory-slot');
      if (!slot || !grid.contains(slot)) return;
      event.preventDefault();
      event.stopPropagation();
      chooseFromSlot(slot);
    });

    grid.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const slot = event.target.closest?.('.inventory-slot');
      if (!slot || !grid.contains(slot)) return;
      event.preventDefault();
      chooseFromSlot(slot);
    });
  }

  function injectStyles() {
    if (document.getElementById('zork-verb-interaction-style')) return;
    const style = document.createElement('style');
    style.id = 'zork-verb-interaction-style';
    style.textContent = `
      .inventory-slot.is-selected-item {
        border-color: rgba(255, 218, 170, 0.78);
        background:
          linear-gradient(180deg, rgba(255, 226, 180, 0.13), rgba(0,0,0,.2)),
          rgba(112, 30, 25, 0.82);
        color: #fff2d8;
        box-shadow: inset 0 0 0 1px rgba(255,255,255,.08), 0 0 12px rgba(125, 32, 29, .35);
      }
      .inventory-slot[role='button'] { cursor: pointer; }
    `;
    document.head.appendChild(style);
  }

  function patchRoomManager() {
    const room = window.RoomManager;
    if (!room || room.__zorkVerbInteractionPatched || typeof room.processInterest !== 'function') return false;
    room.__zorkVerbInteractionPatched = true;
    const original = room.processInterest.bind(room);
    room.processInterest = (interest) => handleVerbInteraction(interest, original);
    return true;
  }

  function tick() {
    injectStyles();
    patchRoomManager();
    bindInventorySelection();
    updateInventorySelection();
    updateVerbReadout();
    requestAnimationFrame(tick);
  }

  window.ZORK_VERB_INTERACTIONS = {
    getSelectedItem: () => state.selectedItemId,
    setSelectedItem,
    clearSelectedItem,
  };

  tick();
})();
