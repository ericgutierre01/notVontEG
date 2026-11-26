# Not Vont EG — puente Bluetooth en un ESP32 (MicroPython).
# Pide órdenes al servidor (long polling) y las ejecuta:
#   {"t":"adv","d":hex,"ms":n}  anuncio BLE durante n ms (abanico ZhiMei)
#   {"t":"gatt","m":MAC,"d":hex} escritura en FFF3 de una tira ELK-BLEDOM
# Configuración en config.json: la escribe la red de configuración (setup.py) o el instalador USB de la app.
import binascii, bluetooth, json, machine, network, time
import requests
import screen


def load_cfg():
    try:
        return json.load(open("config.json"))
    except (OSError, ValueError):
        return {}


def save_cfg(c):
    with open("config.json", "w") as f:
        json.dump(c, f)


def setup(error=""):
    """Sin Wi-Fi o sin clave: abre la red de configuración (no vuelve; reinicia al guardar)."""
    import setup as s
    s.run(load_cfg(), error)


cfg = load_cfg()
if not cfg.get("ssid") or not cfg.get("server") or not (cfg.get("key") or cfg.get("code")):
    setup()

STRIP_NAMES = ("ELK-", "MELK", "LEDDMX", "BLEDOM", "ELK_")

ble = bluetooth.BLE()
ble.active(True)

# ---------- Bluetooth: eventos ----------
_IRQ_SCAN_RESULT, _IRQ_SCAN_DONE = 5, 6
_IRQ_CONNECT, _IRQ_DISCONNECT = 7, 8
_IRQ_CHR_RESULT, _IRQ_CHR_DONE = 11, 12
_IRQ_WRITE_DONE = 17
st = {"conn": None, "mac": None, "chr": None, "done": False, "seen": set(), "scanning": False, "last": 0}


def _name(adv):
    i = 0
    while i + 1 < len(adv):
        n = adv[i]
        if n == 0:
            break
        if adv[i + 1] in (8, 9):
            return bytes(adv[i + 2:i + 1 + n]).decode("utf-8", "ignore")
        i += n + 1
    return ""


def irq(ev, d):
    if ev == _IRQ_SCAN_RESULT:
        n = _name(bytes(d[4]))
        if n.startswith(STRIP_NAMES) and len(st["seen"]) < 16:
            st["seen"].add(binascii.hexlify(bytes(d[1])).decode().upper())
    elif ev == _IRQ_SCAN_DONE:
        st["scanning"] = False
    elif ev == _IRQ_CONNECT:
        st["conn"] = d[0]
    elif ev == _IRQ_DISCONNECT:
        st["conn"], st["chr"], st["mac"] = -1, None, None
    elif ev == _IRQ_CHR_RESULT:
        if str(d[4]).lower().find("fff3") >= 0:
            st["chr"] = d[2]  # value handle
    elif ev in (_IRQ_CHR_DONE, _IRQ_WRITE_DONE):
        st["done"] = True


ble.irq(irq)


def wait(cond, ms):
    t = time.ticks_ms()
    while not cond():
        if time.ticks_diff(time.ticks_ms(), t) > ms:
            return False
        time.sleep_ms(20)
    return True


def scan(ms=5000):
    st["scanning"] = True
    ble.gap_scan(ms, 30000, 30000, True)
    wait(lambda: not st["scanning"], ms + 1000)


# ---------- órdenes ----------
def advertise(hexdata, ms):
    ble.gap_advertise(20000, adv_data=binascii.unhexlify(hexdata), connectable=False)
    time.sleep_ms(min(int(ms), 120000))
    ble.gap_advertise(None)


def disconnect():
    if st["conn"] is not None and st["conn"] >= 0:
        try:
            ble.gap_disconnect(st["conn"])
        except OSError:
            pass
        wait(lambda: st["conn"] == -1, 2000)
    st["conn"], st["chr"], st["mac"] = None, None, None


def connect(mac):
    """Conecta a la tira y busca la característica FFF3. Reintenta: con señal débil falla a veces (0x3E)."""
    if st["mac"] == mac and st["chr"] is not None and st["conn"] is not None and st["conn"] >= 0:
        return True
    disconnect()
    for _ in range(4):
        st["conn"] = None
        ble.gap_connect(0, binascii.unhexlify(mac), 4000)
        if wait(lambda: st["conn"] is not None, 6000) and st["conn"] >= 0:
            st["done"], st["chr"] = False, None
            ble.gattc_discover_characteristics(st["conn"], 1, 0xFFFF)
            wait(lambda: st["done"] or st["conn"] == -1, 4000)
            if st["chr"] is not None:
                st["mac"] = mac
                return True
            disconnect()
        time.sleep_ms(500)
    print("tira", mac, "no conecta")
    return False


def gatt_write(mac, hexdata):
    if connect(mac):
        try:
            ble.gattc_write(st["conn"], st["chr"], binascii.unhexlify(hexdata), 0)
            st["last"] = time.ticks_ms()
            return True
        except OSError as e:
            print("escritura", e)
            disconnect()
    return False


def run(cmd):
    screen.show("Not Vont EG", "En linea", "", cmd.get("l", "Orden recibida"))
    try:
        if cmd.get("t") == "adv":
            advertise(cmd["d"], cmd.get("ms", 1200))
        elif cmd.get("t") == "gatt":
            if not gatt_write(cmd["m"], cmd["d"]):
                screen.show("Not Vont EG", "La tira no", "responde.", "Acerca la placa")
    except Exception as e:  # una orden mala no debe tumbar la placa
        print("orden", cmd, e)


# ---------- red ----------
def wifi():
    w = network.WLAN(network.STA_IF)
    w.active(True)
    if not w.isconnected():
        w.connect(cfg["ssid"], cfg.get("password", ""))
        if not wait(w.isconnected, 20000):
            raise OSError("sin Wi-Fi")
    return w


def claim():
    """Canjea el código de 6 dígitos por la clave de la placa (una sola vez)."""
    while True:
        try:
            r = requests.post(cfg["server"].rstrip("/") + "/hub/claim", json={"code": cfg["code"]}, timeout=20)
            code, body = r.status_code, r.json()
            r.close()
        except Exception as e:  # sin internet / servidor caído: reintenta
            print("claim", e)
            time.sleep(10)
            continue
        if code == 200:
            screen.show("Not Vont EG", "Placa agregada:", body.get("name", ""))
            cfg["key"] = body["key"]
            cfg.pop("code", None)
            save_cfg(cfg)
            print("placa", body.get("name"))
            return
        setup("El código no sirvió (" + body.get("error", str(code)) + "). Pide uno nuevo en la app.")


# Mantener BOOT 5 s: borrar el Wi-Fi y volver a la red de configuración
_boot = machine.Pin(0, machine.Pin.IN, machine.Pin.PULL_UP)
_held = [0]


def _check_boot(_t):
    screen.tick()
    _held[0] = _held[0] + 1 if _boot.value() == 0 else 0
    if _held[0] == 2:
        screen.show("BOOT", "Sigue apretando", "para reconfigurar")
    if _held[0] >= 5:
        c = load_cfg()
        c.pop("ssid", None)
        save_cfg(c)
        machine.reset()


machine.Timer(0).init(period=1000, callback=_check_boot)


def main():
    screen.show("Not Vont EG", "Conectando a", cfg["ssid"])
    try:
        w = wifi()
    except OSError:
        setup('No se pudo conectar a "' + cfg["ssid"] + '". Revisa la contraseña.')
    print("Wi-Fi", w.ifconfig()[0])
    screen.show("Not Vont EG", "Wi-Fi: " + cfg["ssid"], "Conectando al", "servidor...")
    if not cfg.get("key"):
        claim()
    head = {"X-Hub-Key": cfg["key"]}
    url = cfg["server"].rstrip("/") + "/hub/poll"
    scan()
    print("tiras cerca", st["seen"])
    errors, online = 0, False
    while True:
        # deja libre la tira (la app del teléfono también quiere conectarse) tras 60 s sin órdenes
        if st["mac"] and time.ticks_diff(time.ticks_ms(), st["last"]) > 60000:
            disconnect()
        try:
            if not w.isconnected():
                w = wifi()
            r = requests.get(url + "?seen=" + ",".join(sorted(st["seen"])), headers=head, timeout=30)
            if r.status_code == 401:  # la placa se quitó o se reconfiguró en la app
                r.close()
                setup("Esta placa ya no está en tu cuenta. Crea una o pide un código nuevo en la app.")
            if r.status_code == 200:
                if not online:
                    screen.show("Not Vont EG", "En linea", "Wi-Fi: " + cfg["ssid"], "Tiras cerca: " + str(len(st["seen"])))
                online = True
                for c in r.json().get("cmds", []):
                    run(c)
                errors = 0
            else:
                print("servidor", r.status_code)
                errors += 1
                time.sleep(5)
            r.close()
        except Exception as e:
            print("poll", e)
            errors += 1
            if errors == 3:
                online = False
                screen.show("Not Vont EG", "Sin conexion", "con el servidor.", "Reintentando...")
            time.sleep(min(30, 2 * errors))
        if errors > 20:  # algo raro (Wi-Fi, memoria): reinicio limpio
            machine.reset()


main()
