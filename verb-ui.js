(() => {
  const verbs = [
    { id: 'look', label: 'Look At' },
    { id: 'pickup', label: 'Pick Up' },
    { id: 'use', label: 'Use' },
  ];

  const state = {
    selectedVerb: 'use',
    storageKey: 'zork.selectedVerb',
    panel: null,
    label: null,
  };

  function titleForVerb(id) {
    return verbs.find((verb) => verb.id === id)?.label || 'Use';
  }

  function save() {
    localStorage.setItem(state.storageKey, state.selectedVerb);
  }

  function setVerb(id) {
    if (!verbs.some((verb) => verb.id === id)) return;
    state.selectedVerb = id;
    save();
    updateUI();
    window.ZORK_VERB = state.selectedVerb;
    window.dispatchEvent(new CustomEvent('zorkverbchange', { detail: { verb: state.selectedVerb } }));
  }

  function updateUI() {
    if (!state.panel) return;
    state.panel.querySelectorAll('.verb-button').forEach((button) => {
      const selected = button.dataset.verb === state.selectedVerb;
      button.classList.toggle('is-selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    if (state.label) state.label.textContent = titleForVerb(state.selectedVerb);
  }

  function createPanel() {
    if (document.getElementById('verb-panel')) {
      state.panel = document.getElementById('verb-panel');
      state.label = document.getElementById('selected-verb-label');
      updateUI();
      return;
    }

    const overlay = document.getElementById('ui-overlay');
    const inventory = document.getElementById('inventory-panel');
    if (!overlay || !inventory) return;

    const panel = document.createElement('aside');
    panel.id = 'verb-panel';
    panel.className = 'panel';
    panel.setAttribute('aria-label', 'Adventure verbs');

    const title = document.createElement('h2');
    title.textContent = 'Commands';

    const buttons = document.createElement('div');
    buttons.className = 'verb-buttons';

    verbs.forEach((verb) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'verb-button';
      button.dataset.verb = verb.id;
      button.textContent = verb.label;
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        setVerb(verb.id);
      });
      buttons.appendChild(button);
    });

    const current = document.createElement('div');
    current.className = 'verb-current';
    const prefix = document.createElement('span');
    prefix.textContent = 'Selected';
    const label = document.createElement('strong');
    label.id = 'selected-verb-label';
    label.textContent = titleForVerb(state.selectedVerb);
    current.append(prefix, label);

    panel.append(title, buttons, current);
    overlay.insertBefore(panel, inventory.nextSibling);

    state.panel = panel;
    state.label = label;
    updateUI();
  }

  function init() {
    const stored = localStorage.getItem(state.storageKey);
    if (stored && verbs.some((verb) => verb.id === stored)) state.selectedVerb = stored;
    window.ZORK_VERB = state.selectedVerb;
    window.ZORK_VERB_UI = {
      getVerb: () => state.selectedVerb,
      setVerb,
      verbs: () => verbs.map((verb) => ({ ...verb })),
    };
    createPanel();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
