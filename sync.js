// Sync listening progress between devices with Firebase (Google sign-in + Firestore).
// Progress is stored at users/{uid} as { progress: { <guid>: {pos, done, t} } }, with
// ad map requests alongside as { adRequests: { <guid>: {...} } } (see AdRequests in app.js).
// firestore.rules restricts each account to its own document.
import { initializeApp } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut,
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";
import {
  getFirestore, doc, onSnapshot, setDoc,
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";

// Public web-app config (not a secret; access is controlled by firestore.rules).
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyB8frzocd36VJ8Uw369qMv9qJRFns0sGYM",
  authDomain: "handa-player-553cb2.firebaseapp.com",
  projectId: "handa-player-553cb2",
  appId: "1:408789063169:web:c73089280248a46e7a5200",
};

const app = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(app);
const db = getFirestore(app);

const $ = (id) => document.getElementById(id);
const dialog = $("sync-dialog");
let unsubscribe = null;
let state = { status: "off", message: "" };

function render() {
  const user = auth.currentUser;
  $("sync-btn").dataset.state = state.status;
  $("sync-btn").setAttribute("aria-label", `Sync settings (${user ? state.status : "signed out"})`);
  $("sync-signin").hidden = Boolean(user);
  $("sync-signout").hidden = !user;
  const el = $("sync-status");
  el.classList.toggle("error", state.status === "error");
  if (state.status === "error") el.textContent = state.message;
  else if (!user) el.textContent = "Not signed in. Progress is only saved on this device.";
  else if (state.status === "syncing") el.textContent = `Signed in as ${user.email}. Syncing…`;
  else el.textContent = `Signed in as ${user.email}. Progress syncs automatically.`;
}

function setState(status, message = "") {
  state = { status, message };
  render();
}

onAuthStateChanged(auth, (user) => {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  Progress.detach();
  AdRequests.send = null;
  AdRequests.apply({});
  if (!user) return setState("off");

  const ref = doc(db, "users", user.uid);
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
    (err) => setState("error", `Sync failed: ${err.message}`),
  );
});

$("sync-btn").addEventListener("click", () => { render(); dialog.showModal(); });
$("sync-close").addEventListener("click", () => dialog.close());
$("sync-signin").addEventListener("click", async () => {
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
  } catch (err) {
    if (err.code !== "auth/popup-closed-by-user" && err.code !== "auth/cancelled-popup-request") {
      setState("error", `Couldn't sign in: ${err.message}`);
    }
  }
});
$("sync-signout").addEventListener("click", () => signOut(auth));

// Push pending changes straight away when the app is backgrounded or paused.
document.addEventListener("visibilitychange", () => { if (document.hidden) Progress.flush(); });
window.addEventListener("pagehide", () => Progress.flush());
$("audio").addEventListener("pause", () => Progress.flush());
