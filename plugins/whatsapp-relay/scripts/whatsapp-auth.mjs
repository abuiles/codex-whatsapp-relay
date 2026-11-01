import { releaseDaemonSession } from "./daemon-client.mjs";
import { WhatsAppRuntime } from "./runtime.mjs";

const runtime = new WhatsAppRuntime({
  logLevel: process.env.WHATSAPP_LOG_LEVEL ?? "error"
});

// `--phone +15551234567` links with a pairing code instead of a QR.
const phoneIndex = process.argv.indexOf("--phone");
const phoneNumber = phoneIndex > 0 ? process.argv[phoneIndex + 1] : null;

process.stdout.write(`Starting WhatsApp terminal ${phoneNumber ? "pairing-code" : "QR"} authentication...\n`);
process.stdout.write(
  "Open WhatsApp on your phone, then go to Settings -> Linked Devices -> Link a Device.\n"
);

// Pause the relay runtime daemon until this process exits; it reconnects with
// the new credentials afterwards.
await releaseDaemonSession("terminal_qr_auth");
await runtime.start({ printQrToTerminal: !phoneNumber, force: true });
if (phoneNumber) {
  const { pairingCode } = await runtime.startAuthFlow({ phoneNumber });
  process.stdout.write(`\nTap "Link with phone number instead" and type: ${pairingCode.slice(0, 4)}-${pairingCode.slice(4)}\n`);
}

try {
  const socket = await runtime.waitForConnection(5 * 60_000);
  const user = socket.user?.id ?? "unknown";
  process.stdout.write(`\nAuthenticated successfully as ${user}.\n`);
  await runtime.stop();
  process.exit(0);
} catch (error) {
  process.stderr.write(`\nAuthentication failed: ${error.message}\n`);
  process.exit(1);
}
