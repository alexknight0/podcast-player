// Google sign-in (required) and progress sync with Firebase (Auth + Firestore).
// Only approved accounts get in: firestore.rules lets an account read its own users/{uid}
// document only if it's the admin or its email is in config/access.emails, so reading that
// document is the approval check. The app (app.js) starts once it succeeds.
// Progress is stored at users/{uid} as { progress: { <guid>: {pos, done, t} } }, with
// ad map requests alongside as { adRequests: { <guid>: {...} } } (see AdRequests in app.js).
import { initializeApp } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut,
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";
import {
  getFirestore, doc, getDoc, onSnapshot, setDoc,
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";

// Public web-app config (not a secret; access is controlled by firestore.rules).
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyB8frzocd36VJ8Uw369qMv9qJRFns0sGYM",
  authDomain: "handa-player-553cb2.firebaseapp.com",
  projectId: "handa-player-553cb2",
  appId: "1:408789063169:web:c73089280248a46e7a5200",
};
// Remembers which account was approved on this device, so the app opens straight away
// (and offline) while the approval is re-checked in the background.
const APPROVED_KEY = "approvedUid";

const app = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(app);
const db = getFirestore(app);

const $ = (id) => document.getElementById(id);
const dialog = $("sync-dialog");
let unsubscribe = null;
let state = { status: "off", message: "" };

// ---------- gate ----------

function showGate(message, { signIn = false, signOut: canSignOut = false, error = false } = {}) {
  document.body.classList.add("locked");
  $("gate-msg").textContent = message;
  $("gate-msg").classList.toggle("error", error);
  $("gate-signin").hidden = !signIn;
  $("gate-signout").hidden = !canSignOut;
}

function notApproved(user) {
  localStorage.removeItem(APPROVED_KEY);
  stopSync();
  if (!document.body.classList.contains("locked")) return location.reload(); // access was removed while open
  showGate(`${user.email} isn't approved for Podcast Player. Ask Alex to add it, or use a different account.`,
    { signOut: true, error: true });
}

async function signIn() {
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
  } catch (err) {
    if (err.code !== "auth/popup-closed-by-user" && err.code !== "auth/cancelled-popup-request") {
      showGate(`Couldn't sign in: ${err.message}`, { signIn: true, error: true });
    }
  }
}

$("gate-signin").addEventListener("click", signIn);
$("gate-signout").addEventListener("click", () => signOut(auth));

// ---------- sync ----------

function render() {
  const user = auth.currentUser;
  $("sync-btn").dataset.state = state.status;
  $("sync-btn").setAttribute("aria-label", `Sync settings (${state.status})`);
  const el = $("sync-status");
  el.classList.toggle("error", state.status === "error");
  if (state.status === "error") el.textContent = state.message;
  else if (state.status === "syncing") el.textContent = `Signed in as ${user?.email}. Syncing…`;
  else el.textContent = `Signed in as ${user?.email}. Progress syncs automatically.`;
}

function setState(status, message = "") {
  state = { status, message };
  render();
}

function stopSync() {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  Progress.detach();
  AdRequests.send = null;
  AdRequests.apply({});
}

function startSync(user, ref) {
  Progress.attach({
    push: async (entries) => {
      await setDoc(ref, { progress: entries }, { merge: true });
    },
  });
  // Ad map requests (tap on "AD ?"); built and cleared by .github/workflows/admap-requests.yml.
  AdRequests.send = (ep) => setDoc(ref, {
    adRequests: { [ep.guid]: { show: ep.show, title: ep.title, status: "pending", t: Date.now() } },
  }, { merge: true });
  setState("syncing");
  // Live updates: changes from other devices arrive here within a second or two.
  unsubscribe = onSnapshot(
    ref,
    (snap) => {
      Progress.applyRemote(snap.data()?.progress || {});
      AdRequests.apply(snap.data()?.adRequests || {});
      setState("ok");
    },
    (err) => {
      if (err.code === "permission-denied") return notApproved(user);
      setState("error", `Sync failed: ${err.message}`);
    },
  );
}

onAuthStateChanged(auth, async (user) => {
  stopSync();
  if (!user) {
    localStorage.removeItem(APPROVED_KEY);
    if (!document.body.classList.contains("locked")) return location.reload(); // signed out: back to the gate
    return showGate("Sign in with your Google account to continue.", { signIn: true });
  }

  const ref = doc(db, "users", user.uid);
  const knownGood = localStorage.getItem(APPROVED_KEY) === user.uid;
  if (knownGood) startApp();
  else showGate(`Checking access for ${user.email}…`);
  try {
    await getDoc(ref); // denied unless approved
  } catch (err) {
    if (err.code === "permission-denied") return notApproved(user);
    // Offline or Firestore unreachable: only a device that was approved before gets in.
    if (!knownGood) return showGate(`Couldn't check access (${err.message}). Check your connection and reload.`,
      { signOut: true, error: true });
  }
  localStorage.setItem(APPROVED_KEY, user.uid);
  startApp();
  startSync(user, ref);
});

$("sync-btn").addEventListener("click", () => { render(); dialog.showModal(); });
$("sync-close").addEventListener("click", () => dialog.close());
$("sync-signout").addEventListener("click", () => signOut(auth));

// Push pending changes straight away when the app is backgrounded or paused.
document.addEventListener("visibilitychange", () => { if (document.hidden) Progress.flush(); });
window.addEventListener("pagehide", () => Progress.flush());
$("audio").addEventListener("pause", () => Progress.flush());
