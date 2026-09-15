/**
 * Scheduled competition-start notifier.
 *
 * WHY THIS EXISTS (read this before touching it):
 * This app runs on Firebase's Spark (free) plan — no Cloud Functions, no
 * scheduled server-side triggers. Every notification feature built before
 * this one was either (a) a LOCAL on-device notification (only fires for
 * whoever's device it's scheduled on, useless for "tell everyone a
 * competition just started"), or (b) a fully MANUAL step where the admin
 * had to remember to open Firebase Console and send a push themselves —
 * which is what "the automatic push notification isn't working" actually
 * meant: there was no automatic path, only a manual one the admin had to
 * remember to use, exactly at the right moment, every single time.
 *
 * This script IS that missing automatic path. It doesn't run inside the
 * app or on any user's device — it runs on a schedule via GitHub Actions
 * (see .github/workflows/competition-start-notify.yml), using a Firebase
 * service account to act with full admin privileges (bypassing Firestore
 * rules entirely, same as any Cloud Function would). On each run it:
 *   1. Reads every published, competition-type batch in `mcqBatches`.
 *   2. For any whose `scheduledStart` has arrived within the last N
 *      minutes (N = how often this workflow runs) AND hasn't already been
 *      notified, it:
 *      a. Creates an in-app Announcement doc (shows in the bell icon,
 *         and pops up on next app open) — the "in-app notification" half.
 *      b. Sends a real FCM push to the `competitions` topic — the "system
 *         notification" half, using firebase-admin's built-in messaging
 *         API (which handles service-account auth internally, no manual
 *         OAuth/REST plumbing needed).
 *   3. Marks the batch `startNotificationSent: true` so re-running this
 *      script (it runs every few minutes, indefinitely) never double-sends.
 *
 * COST: this genuinely costs nothing extra on Firebase — the service
 * account can read/write Firestore and send FCM messages on the Spark
 * plan already; those are not Blaze-only capabilities. Cloud Functions (a
 * specific way of RUNNING code on Firebase's servers) is the Blaze-only
 * part, and this script deliberately runs somewhere else instead (GitHub
 * Actions) to avoid needing that.
 *
 * SETUP (one-time, by the admin):
 *   1. Firebase Console → Project Settings → Service Accounts →
 *      "Generate new private key" → downloads a JSON file.
 *   2. In the GitHub repo: Settings → Secrets and variables → Actions →
 *      New repository secret, name it FIREBASE_SERVICE_ACCOUNT_JSON,
 *      paste the ENTIRE contents of that JSON file as the value.
 *   3. That's it — the workflow file already references this secret.
 *
 * COST CAVEAT WORTH KNOWING: GitHub Actions minutes are unlimited/free
 * for PUBLIC repos, but limited (2,000 min/month) for PRIVATE ones. This
 * workflow is configured to run every 10 minutes by default — for a
 * public repo that's free forever; for a private repo, do the math against
 * your plan's included minutes (roughly 30-60s per run × number of runs)
 * before assuming it's free, or widen the schedule interval.
 */

const admin = require("firebase-admin");

function initAdmin() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON environment variable is not set.");
  const serviceAccount = JSON.parse(raw);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

// How far back to look for "just started" competitions. Should be a bit
// larger than the workflow's schedule interval so a slow/delayed run
// (GitHub Actions cron is best-effort, not exact-to-the-minute) doesn't
// miss one — but not so large that a competition could get notified long
// after it actually started.
const LOOKBACK_MINUTES = 15;

async function main() {
  initAdmin();
  const db = admin.firestore();
  const messaging = admin.messaging();

  const now = Date.now();
  const lookbackStart = now - LOOKBACK_MINUTES * 60000;

  const snap = await db.collection("mcqBatches")
    .where("isCompetition", "==", true)
    .where("status", "==", "published")
    .get();

  let notifiedCount = 0;

  for (const docSnap of snap.docs) {
    const batch = docSnap.data();
    if (batch.startNotificationSent) continue;
    if (!batch.scheduledStart) continue;

    const startMs = batch.scheduledStart.toDate ? batch.scheduledStart.toDate().getTime() : new Date(batch.scheduledStart).getTime();
    const hasStarted = startMs <= now;
    const isRecentEnough = startMs >= lookbackStart;
    if (!hasStarted || !isRecentEnough) continue;

    console.log(`Notifying for competition "${batch.title}" (${docSnap.id}), started at ${new Date(startMs).toISOString()}`);

    // 1. In-app announcement (bell icon + popup on next open)
    await db.collection("announcements").add({
      title: `🏆 ${batch.title} is live now!`,
      body: batch.prizeDescription
        ? `The competition has started — ${batch.prizeDescription}. Open Exercise → Batches & Competitions to join before it closes.`
        : `The competition has started. Open Exercise → Batches & Competitions to join before it closes.`,
      type: "success",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      active: true,
      showAsPopup: true,
    });

    // 2. Real push notification via FCM, to every device subscribed to
    // the "competitions" topic (see lib/pushNotifications.ts in the app).
    try {
      await messaging.send({
        topic: "competitions",
        notification: {
          title: `🏆 ${batch.title} is live now!`,
          body: "Tap to join the competition before it closes.",
        },
        android: { priority: "high" },
      });
    } catch (err) {
      // Don't let a push failure block marking the announcement as sent —
      // the in-app announcement above already succeeded, and we don't
      // want to spam-retry the push (or the announcement) on the next run.
      console.error(`FCM send failed for "${batch.title}":`, err.message);
    }

    await docSnap.ref.update({ startNotificationSent: true });
    notifiedCount++;
  }

  console.log(`Done. Notified ${notifiedCount} competition(s) this run.`);
}

main().catch((err) => {
  console.error("Competition notifier failed:", err);
  process.exit(1);
});
