import { ESPLoader, Transport } from 'esptool-js';

/** Instalador por USB (Web Serial, solo Chrome/Edge de computadora): escribe MicroPython en la placa y luego
 * copia el firmware y config.json por el REPL. La contraseña del Wi-Fi va del navegador a la placa por el cable;
 * nunca pasa por el servidor. */

// Tipos mínimos de Web Serial (el proyecto no trae @types/w3c-web-serial)
interface Port {
  open(o: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  setSignals(s: { dataTerminalReady?: boolean; requestToSend?: boolean }): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
}

export const usbSupported = () => 'serial' in navigator;

export const FIRMWARE_URL = 'esp32/micropython-esp32-v1.29.0.bin';

export async function pickPort(): Promise<Port> {
  return (navigator as unknown as { serial: { requestPort(): Promise<Port> } }).serial.requestPort();
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Borra la placa y escribe MicroPython (en 0x1000, como indica micropython.org para ESP32). */
export async function flashMicroPython(port: Port, progress: (pct: number) => void) {
  const bin = new Uint8Array(await (await fetch(FIRMWARE_URL)).arrayBuffer());
  let data = '';
  for (let i = 0; i < bin.length; i += 0x8000) data += String.fromCharCode(...bin.subarray(i, i + 0x8000));
  const transport = new Transport(port as never, false);
  try {
    const loader = new ESPLoader({ transport, baudrate: 460800, romBaudrate: 115200 });
    const desc = await loader.main();
    // familia ESP32 clásica (D0WD, WROOM-32); S2/S3/C3 necesitan otro firmware
    if (loader.chip.CHIP_NAME !== 'ESP32') throw new Error(`Esta placa es ${desc}; el instalador es para ESP32 (WROOM-32).`);
    await loader.writeFlash({
      fileArray: [{ data, address: 0x1000 }], flashSize: 'keep', flashMode: 'keep', flashFreq: 'keep',
      eraseAll: true, compress: true, reportProgress: (_f, written, total) => progress(Math.round(written / total * 100)),
    });
    await loader.after('hard_reset');
  } finally {
    await transport.disconnect();
  }
}

/** REPL "raw" de MicroPython sobre el puerto serie: suficiente para escribir archivos y reiniciar. */
export async function writeFiles(port: Port, files: Record<string, string>, log: (m: string) => void) {
  await port.open({ baudRate: 115200 });
  const writer = port.writable!.getWriter();
  const reader = port.readable!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let reading = true;
  const pump = (async () => {
    while (reading) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
    }
  })().catch(() => { /* puerto cerrado */ });

  const send = async (s: string) => {
    const bytes = new TextEncoder().encode(s);
    for (let i = 0; i < bytes.length; i += 256) { await writer.write(bytes.subarray(i, i + 256)); await sleep(10); }
  };
  /** Espera `token` y devuelve lo recibido antes de él (lo consume del búfer). */
  const waitFor = async (token: string, ms: number) => {
    const t = Date.now();
    while (!buf.includes(token)) {
      if (Date.now() - t > ms) throw new Error('La placa no responde. ¿Tiene MicroPython? Prueba marcando "Instalar firmware".');
      await sleep(30);
    }
    const i = buf.indexOf(token);
    const before = buf.slice(0, i);
    buf = buf.slice(i + token.length);
    return before;
  };
  /** Ejecuta código en el REPL raw. Respuesta: "OK" salida "\x04" error "\x04>". Devuelve la salida. */
  const replExec = async (code: string) => {
    buf = '';
    await send(code + '\x04');
    await waitFor('OK', 5000);
    const [out, err] = (await waitFor('\x04>', 15000)).split('\x04');
    if (err?.trim()) throw new Error('Error en la placa: ' + err.trim().split('\n').pop());
    return out;
  };

  try {
    await port.setSignals({ dataTerminalReady: false, requestToSend: false });
    await send('\r\x03\x03'); // detiene main.py
    await sleep(400);
    buf = '';
    await send('\x01'); // REPL raw
    await waitFor('raw REPL; CTRL-B to exit\r\n>', 5000);
    await replExec('import binascii');
    for (const [name, text] of Object.entries(files)) {
      log(`Copiando ${name}…`);
      const bytes = new TextEncoder().encode(text);
      await replExec(`f=open('${name}','wb')`);
      for (let i = 0; i < bytes.length; i += 384) {
        let bin = '';
        for (const b of bytes.subarray(i, i + 384)) bin += String.fromCharCode(b);
        await replExec(`f.write(binascii.a2b_base64('${btoa(bin)}'))`);
      }
      await replExec('f.close()');
    }
    // comprobación: los archivos quedaron con el tamaño esperado
    const sizes = Object.entries(files).map(([n, t]) => `${new TextEncoder().encode(t).length}==__import__('os').stat('${n}')[6]`);
    if (!(await replExec(`print('OK!' if ${sizes.join(' and ')} else 'MAL')`)).includes('OK!'))
      throw new Error('Los archivos no quedaron completos en la placa. Inténtalo de nuevo.');
    await send('\x02'); // sale del REPL raw
  } finally {
    reading = false;
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    writer.releaseLock();
    await pump;
    // reinicio por hardware (RTS → EN), como esptool
    await port.setSignals({ dataTerminalReady: false, requestToSend: true }).catch(() => {});
    await sleep(120);
    await port.setSignals({ dataTerminalReady: false, requestToSend: false }).catch(() => {});
    await port.close().catch(() => {});
  }
}
