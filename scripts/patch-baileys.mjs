import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Backport https://github.com/WhiskeySockets/Baileys/pull/2765 and /2749.
const dependency = new URL("../node_modules/@whiskeysockets/baileys/", import.meta.url);
const metadata = JSON.parse(await fs.readFile(new URL("package.json", dependency), "utf8"));
if (metadata.version !== "7.0.0-rc14") {
  throw new Error(`Review the pairing backport before using Baileys ${metadata.version}`);
}

function replaceOnce(source, before, after) {
  if (source.includes(after)) return source;
  if (source.split(before).length !== 2) {
    throw new Error("Baileys source differs from the reviewed rc14 pairing code");
  }
  return source.replace(before, after);
}

const socketPath = new URL("lib/Socket/socket.js", dependency);
let socket = await fs.readFile(socketPath, "utf8");
socket = replaceOnce(socket,
  "    // QR gen\n",
  "    let refreshPairingQR;\n    // QR gen\n");
socket = replaceOnce(socket,
  "        const advB64 = creds.advSecretKey;",
  `        let currentPairingRef;
        refreshPairingQR = () => {
            if (!currentPairingRef || !ws.isOpen || creds.me) return;
            const qr = buildPairingQRData(currentPairingRef, noiseKeyB64, identityKeyB64, creds.advSecretKey, browser);
            ev.emit('connection.update', { qr });
        };`);
socket = replaceOnce(socket,
  `            const ref = refNode.content.toString('utf-8');
            const qr = buildPairingQRData(ref, noiseKeyB64, identityKeyB64, advB64, browser);
            ev.emit('connection.update', { qr });`,
  `            currentPairingRef = refNode.content.toString('utf-8');
            refreshPairingQR();`);
socket = replaceOnce(socket,
  "    // device paired for the first time\n",
  `    ws.on('CB:notification,type:companion_reg_refresh', (node) => {
        if (creds.me || !ws.isOpen || !refreshPairingQR) return;
        if (!getBinaryNodeChild(node, 'companion_reg_refresh') &&
            !getBinaryNodeChild(node, 'pair-device-rotate-qr')) return;
        creds.advSecretKey = randomBytes(32).toString('base64');
        ev.emit('creds.update', { advSecretKey: creds.advSecretKey });
        refreshPairingQR();
    });
    // device paired for the first time
`);

const receivePath = new URL("lib/Socket/messages-recv.js", dependency);
let receive = await fs.readFile(receivePath, "utf8");
receive = replaceOnce(receive,
  "buildAckStanza(node, errorCode, authState.creds.me.id)",
  "buildAckStanza(node, errorCode, authState.creds.me?.id)");

await fs.writeFile(socketPath, socket);
await fs.writeFile(receivePath, receive);
console.log(`Applied reviewed pairing fixes to ${fileURLToPath(dependency)}`);
