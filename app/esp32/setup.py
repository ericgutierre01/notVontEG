# Red de configuración: la placa crea la red abierta "NotVontEG-XXXX" con un portal cautivo.
# Desde el teléfono eliges tu Wi-Fi, escribes la contraseña y el código de 6 dígitos de la app.
# La contraseña va del teléfono a la placa directo (nunca pasa por el servidor).
# Límites conocidos: la red es abierta mientras dura la configuración (como enchufes y cámaras baratos);
# quien esté cerca en ese momento podría enviar el formulario, pero sin un código válido de tu cuenta la
# placa no queda en ninguna cuenta. El HTTPS de MicroPython no verifica el certificado del servidor.
import binascii, json, machine, network, socket, time

PAGE = """<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Not Vont EG</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#0f1115;color:#eef0f5;margin:0;padding:24px}
main{max-width:420px;margin:auto}h1{font-size:24px;margin:0 0 4px}p{color:#9aa3b2;line-height:1.5}
label{display:block;margin:16px 0 6px;font-size:14px;color:#9aa3b2}
input,select{width:100%;box-sizing:border-box;padding:14px;border-radius:12px;border:1px solid #2a2f3d;
background:#171a21;color:#eef0f5;font-size:17px}button{margin-top:22px;width:100%;padding:15px;border:none;
border-radius:14px;background:linear-gradient(135deg,#7c5cff,#4cc9f0);color:#fff;font-size:17px;font-weight:600}
.err{background:#3a1d22;color:#ffb4b4;padding:12px;border-radius:12px}details{margin-top:16px;color:#9aa3b2}</style>
</head><body><main><h1>Configurar placa</h1><p>Conéctala a tu Wi-Fi y a tu cuenta.</p>%ERR%
<form method="post" action="/save">
<label for="s">Red Wi-Fi (2.4 GHz)</label><select id="s" name="ssid">%NETS%</select>
<label for="o">… o escribe el nombre</label><input id="o" name="other" autocomplete="off" autocapitalize="none">
<label for="p">Contraseña del Wi-Fi</label><input id="p" name="password" type="password" autocomplete="off">
<label for="c">Código de 6 dígitos (app → Placas ESP32)</label>
<input id="c" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required>
<details><summary>Avanzado</summary><label for="v">Servidor</label>
<input id="v" name="server" value="%SERVER%" autocapitalize="none" required></details>
<button>Guardar y conectar</button></form></main></body></html>"""

DONE = """<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Listo</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#0f1115;color:#eef0f5;padding:24px}</style>
</head><body><h1>Listo</h1><p>La placa se reinicia y se conecta a tu Wi-Fi. En un minuto aparecerá
<b>En línea</b> en la app. Ya puedes volver a tu red Wi-Fi normal.</p></body></html>"""


def _esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def _unquote(s):
    s = s.replace("+", " ")
    out, i = bytearray(), 0
    b = s.encode()
    while i < len(b):
        if b[i] == 37 and i + 2 < len(b):  # %
            out.append(int(b[i + 1:i + 3], 16))
            i += 3
        else:
            out.append(b[i])
            i += 1
    return out.decode()


def _form(body):
    f = {}
    for part in body.split("&"):
        if "=" in part:
            k, v = part.split("=", 1)
            f[_unquote(k)] = _unquote(v)
    return f


def _dns_reply(q):
    # responde cualquier consulta A con 192.168.4.1 (así el teléfono abre el portal solo)
    return q[:2] + b"\x81\x80" + q[4:6] + q[4:6] + b"\x00\x00\x00\x00" + q[12:] + \
        b"\xc0\x0c\x00\x01\x00\x01\x00\x00\x00\x3c\x00\x04\xc0\xa8\x04\x01"


def run(cfg, error=""):
    sta = network.WLAN(network.STA_IF)
    sta.active(True)
    try:
        nets = sorted({n[0].decode("utf-8", "ignore") for n in sta.scan() if n[0]})
    except OSError:
        nets = []
    sta.active(False)

    ap = network.WLAN(network.AP_IF)
    ap.active(True)
    name = "NotVontEG-" + binascii.hexlify(ap.config("mac")).decode()[-4:].upper()
    ap.config(essid=name, authmode=0)
    print("red de configuración:", name, error)
    try:
        import screen
        screen.show("Configurar", "Conectate a la", "red Wi-Fi:", name, "y pon el codigo" if not error else "Hubo un error:", "" if not error else error)
    except Exception as e:
        print("pantalla", e)

    opts = "".join('<option%s>%s</option>' % (" selected" if n == cfg.get("ssid") else "", _esc(n)) for n in nets)
    page = PAGE.replace("%NETS%", opts or "<option value=''>(no se encontraron redes)</option>") \
        .replace("%ERR%", '<p class="err">%s</p>' % _esc(error) if error else "") \
        .replace("%SERVER%", _esc(cfg.get("server", "")))

    dns = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    dns.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    dns.bind(("0.0.0.0", 53))
    dns.setblocking(False)
    web = socket.socket()
    web.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    web.bind(("0.0.0.0", 80))
    web.listen(4)
    web.settimeout(0.2)

    while True:
        try:
            q, addr = dns.recvfrom(512)
            dns.sendto(_dns_reply(q), addr)
        except OSError:
            pass
        try:
            c, _ = web.accept()
        except OSError:
            continue
        try:
            c.settimeout(3)
            req = c.recv(2048).decode("utf-8", "ignore")
            if req.startswith("POST /save"):
                head, _, body = req.partition("\r\n\r\n")
                want = 0
                for line in head.split("\r\n"):
                    if line.lower().startswith("content-length:"):
                        try:
                            want = min(int(line.split(":")[1]), 2048)  # el formulario ocupa mucho menos
                        except ValueError:
                            want = 0
                while len(body.encode()) < want:
                    more = c.recv(1024)
                    if not more:
                        break
                    body += more.decode("utf-8", "ignore")
                f = _form(body)
                ssid = (f.get("other") or f.get("ssid") or "").strip()
                code = f.get("code", "").strip()
                server = f.get("server", "").strip()
                if not ssid or len(code) != 6 or not code.isdigit() or not server:
                    c.send(b"HTTP/1.1 303 See Other\r\nLocation: /\r\n\r\n")
                else:
                    cfg.update({"ssid": ssid, "password": f.get("password", ""), "server": server, "code": code})
                    cfg.pop("key", None)
                    with open("config.json", "w") as fh:
                        json.dump(cfg, fh)
                    c.send(b"HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n\r\n")
                    c.send(DONE.encode())
                    try:
                        import screen
                        screen.show("Configurar", "Guardado.", "Reiniciando...")
                    except Exception:
                        pass
                    c.close()
                    time.sleep(2)
                    machine.reset()
            else:
                # cualquier otra ruta (incluidas las pruebas de portal de iOS/Android) muestra el formulario
                c.send(b"HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n")
                data = page.encode()
                for i in range(0, len(data), 1024):
                    c.send(data[i:i + 1024])
        except Exception as e:  # una petición rara no debe tumbar el portal
            print("portal", e)
        finally:
            c.close()
