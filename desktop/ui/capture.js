/**
 * The capture panel.
 *
 * One rule runs through all of it: **the field is cleared only when the server
 * has said it wrote the thought down.** Everything else — offline, a session that
 * expired, a refusal, a server that said nothing — leaves the text alone and puts
 * a line under it. There is no draft on disk and no queue; the thought stays
 * visible in the window, which is the one place it cannot rot unnoticed.
 */

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const thought = document.querySelector('#thought');
const status = document.querySelector('#status');
const signIn = document.querySelector('#sign-in');
const account = document.querySelector('#account');
const password = document.querySelector('#password');

let copy = null;
/** Set by the first Esc over an unsent thought; cleared by anything else. */
let warned = false;

function say(message) {
  status.textContent = message ?? '';
}

/** Fills every label from `copy.rs`; this file writes no words of its own. */
async function dress() {
  const ready = await invoke('ready');
  copy = ready.copy;

  thought.placeholder = copy.placeholder;
  document.querySelector('#sign-in-title').textContent = copy.sign_in_title;
  document.querySelector('#account-label').textContent = copy.account_label;
  document.querySelector('#password-label').textContent = copy.password_label;
  document.querySelector('#sign-in-button').textContent = copy.sign_in_button;

  account.value = ready.account;
  // A settings file that could not be read is named rather than swallowed; the
  // defaults are in use either way.
  say(ready.problem ?? copy.send_hint);
  if (!ready.signed_in) reveal();
}

function reveal() {
  signIn.hidden = false;
  // The thought keeps the focus if there is one: the password is the detour, not
  // the errand.
  (thought.value.trim() === '' ? thought : password).focus();
}

function conceal() {
  signIn.hidden = true;
  password.value = '';
}

/** Applies what came back. The only path that clears the field. */
function settle(reply) {
  warned = false;

  if (reply.saved) {
    thought.value = '';
    conceal();
    // Said and then hidden, which looks like saying nothing — and is on purpose.
    // The panel going away is the confirmation, because the point is to be back
    // in the other window; and the line stays, so the next time the panel opens
    // it still says where the last thought went. Silent success would otherwise
    // never tell anybody which note they have been filling.
    say(reply.message);
    void invoke('dismiss');
    return;
  }

  if (reply.needs_sign_in) reveal();
  else conceal();
  say(reply.message === '' ? copy.send_hint : reply.message);
}

async function send() {
  if (thought.value.trim() === '') {
    say(copy.send_hint);
    return;
  }
  say(copy.sending);

  const reply = signIn.hidden
    ? await invoke('capture', { text: thought.value })
    : await invoke('sign_in', {
        account: account.value,
        password: password.value,
        text: thought.value,
      });

  settle(reply);
}

document.addEventListener('keydown', (event) => {
  // `dress` is the first thing that runs, but it is a round trip: a keystroke in
  // the moment before it lands would otherwise read a label off `null`.
  if (copy === null) return;

  // ⌘↵ sends, the same combination the start page's capture field uses.
  if (event.key === 'Enter' && event.metaKey) {
    event.preventDefault();
    void send();
    return;
  }

  // ⌘⌫ discards, deliberately and only on purpose.
  if (event.key === 'Backspace' && event.metaKey) {
    event.preventDefault();
    thought.value = '';
    warned = false;
    say(copy.send_hint);
    thought.focus();
    return;
  }

  if (event.key === 'Escape') {
    event.preventDefault();

    // The one place the window refuses to go away. Hiding a panel that still
    // holds an unsent thought is exactly how the thought would be lost quietly,
    // so the first Escape says so and only the second puts it away — by which
    // point it was a decision rather than a reflex.
    if (thought.value.trim() !== '' && !warned) {
      warned = true;
      say(copy.unsent_on_escape);
      return;
    }

    void invoke('dismiss');
  }
});

signIn.addEventListener('submit', (event) => {
  event.preventDefault();
  void send();
});

// The window is shown rather than created, so focus has to be taken again every
// time; and a thought left over from a failed attempt is selected rather than
// cleared, so the next keystroke can replace it without losing it by accident.
void listen('panel-shown', () => {
  thought.focus();
  if (thought.value !== '') thought.select();
});

// Signing out happens in the menu, where there is nothing to show a result on.
void listen('signed-out', () => {
  if (copy === null) return;
  say(copy.signed_out);
  reveal();
});

void dress();
