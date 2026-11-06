"""Alexa Smart Home skill para aparatos Vont/Topband — SIN dependencias externas.

Todo con librería estándar de Python (urllib + socket/ssl), para pegarlo directo en
el editor en línea de AWS Lambda (runtime Python 3.12), sin subir ningún .zip.

Variables de entorno (las pones TÚ en la consola de AWS Lambda):
  TOPBAND_USER = correo de tu cuenta Vont
  TOPBAND_PASS = contraseña de tu cuenta Vont

Protocolo Topband extraído del APK com.vont.smartlight (ver PROTOCOL.md del repo).
Account linking de Alexa: Login with Amazon (el token se ignora; skill personal).
"""
import colorsys
import hashlib
import json
import logging
import os
import re
import socket
import ssl
import struct
import time
import urllib.request
import uuid

logger = logging.getLogger()
logger.setLevel(logging.INFO)

COMPANY_ID = "e1288ab93107470daf3f7bc3499654d9"
PROJECT_ID = "6512219a33df427cbd59ea300818701c"
USER_API = "https://us-tsmart-user-api.topband-cloud.com/tsmart-user-api"
DEVICE_API = "https://us-tsmart-device-api.topband-cloud.com/tsmart-device-api"
MQTT_HOST = "us-tsmart-mqtt.topband-cloud.com"
MQTT_PORT = 8883

_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

# ----------------------------------------------------------------- HTTP/REST
def _post(url, body, token=None):
    headers = {"Content-Type": "application/json", "App-Project-Id": PROJECT_ID,
               "Accept-Language": "en-US"}
    if token:
        headers["Authorization"] = token
    req = urllib.request.Request(url, data=json.dumps(body).encode(),
                                 headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=12) as r:
        return json.loads(r.read().decode())


_SESSION = {"token": None, "user_id": None, "ts": 0}
_SESSION_TTL = 3600


def _login():
    now = time.time()
    if _SESSION["token"] and now - _SESSION["ts"] < _SESSION_TTL:
        return _SESSION
    user = os.environ["TOPBAND_USER"]
    pw = hashlib.md5(os.environ["TOPBAND_PASS"].encode()).hexdigest()
    d = _post(USER_API + "/appLogin/v2/login",
              {"userName": user, "password": pw, "companyId": COMPANY_ID})
    data = d.get("data", d)
    token = data.get("token") or d.get("token")
    if not token:
        raise RuntimeError("login sin token")
    _SESSION.update(token=token, user_id=str(data.get("userId") or data.get("uid") or ""),
                    ts=now)
    return _SESSION


def _devices(token):
    d = _post(DEVICE_API + "/device/all", {}, token)
    p = d.get("data", d)
    if isinstance(p, dict):
        for k in ("rows", "list", "deviceList", "devices"):
            if k in p:
                return p[k]
    return p if isinstance(p, list) else []


# ------------------------------------------------------------- MQTT mínimo
def _mqtt_str(s: bytes) -> bytes:
    return struct.pack(">H", len(s)) + s


def _remaining_length(n: int) -> bytes:
    out = b""
    while True:
        b = n % 128
        n //= 128
        if n > 0:
            b |= 0x80
        out += bytes([b])
        if n == 0:
            return out


def mqtt_publish(client_id, username, password, topic, payload):
    """CONNECT + PUBLISH (QoS0) con TLS, usando solo stdlib. Una ráfaga y cierra."""
    ctx = ssl.create_default_context()
    raw = socket.create_connection((MQTT_HOST, MQTT_PORT), timeout=10)
    sock = ctx.wrap_socket(raw, server_hostname=MQTT_HOST)
    try:
        cid = client_id.encode(); usr = username.encode(); pwd = password.encode()
        var = b"\x00\x04MQTT\x04\xc2" + struct.pack(">H", 30)  # proto, flags user+pass+clean, keepalive
        pl = _mqtt_str(cid) + _mqtt_str(usr) + _mqtt_str(pwd)
        connect = b"\x10" + _remaining_length(len(var) + len(pl)) + var + pl
        sock.sendall(connect)
        resp = sock.recv(4)  # CONNACK
        if len(resp) < 4 or resp[0] != 0x20 or resp[3] != 0x00:
            raise RuntimeError(f"MQTT CONNACK rechazado: {resp!r}")
        body = payload.encode()
        pub_var = _mqtt_str(topic.encode())  # QoS0: sin packet id
        publish = b"\x30" + _remaining_length(len(pub_var) + len(body)) + pub_var + body
        sock.sendall(publish)
        time.sleep(0.4)  # deja salir el paquete antes de cerrar
    finally:
        try:
            sock.sendall(b"\xe0\x00")  # DISCONNECT
        except OSError:
            pass
        sock.close()


# ------------------------------------------------------ comandos de aparato
BOOL, BYTE, INT = 9, 1, 5


def _send_dp(sess, product_id, uid, attrs):
    if not (_ID_RE.match(product_id) and _ID_RE.match(uid)):
        raise RuntimeError("productId/uid inválidos")
    payload = {"method": "command",
               "common": {"timestamp": int(time.time() * 1000),
                          "serial": str(int(time.time() * 1000)) + "01",
                          "productId": product_id, "uid": uid},
               "data": [{"mac": "", "cmd": 99, "command": attrs}]}
    # clientId aleatorio no-vacío (el broker rechaza el vacío; no requiere el userId).
    mqtt_publish("vb-" + uuid.uuid4().hex[:16], f"app/{sess['token']}", sess["token"],
                 f"{product_id}/{uid}/download/point/data", json.dumps(payload))


def _set_power(sess, pid, uid, on):
    _send_dp(sess, pid, uid, [{"i": 1, "t": BOOL, "v": bool(on)}])


def _set_brightness(sess, pid, uid, pct):
    _send_dp(sess, pid, uid, [{"i": 7, "t": BYTE, "v": max(0, min(100, int(pct)))}])


def _set_color(sess, pid, uid, r, g, b):
    rgb = (r & 255) << 16 | (g & 255) << 8 | (b & 255)
    _send_dp(sess, pid, uid, [{"i": 6, "t": INT, "v": rgb}])


# ------------------------------------------------------------- Alexa Discovery
def _is_bulb(model):
    return model.upper().startswith("SLB")


def _cap(interface, props):
    return {"type": "AlexaInterface", "interface": interface, "version": "3",
            "properties": {"supported": props, "proactivelyReported": False,
                           "retrievable": True}}


def _discover():
    sess = _login()
    eps = []
    for d in _devices(sess["token"]):
        model = d.get("model", "")
        caps = [{"type": "AlexaInterface", "interface": "Alexa", "version": "3"},
                _cap("Alexa.PowerController", [{"name": "powerState"}]),
                _cap("Alexa.EndpointHealth", [{"name": "connectivity"}])]
        if _is_bulb(model):
            caps.append(_cap("Alexa.BrightnessController", [{"name": "brightness"}]))
            caps.append(_cap("Alexa.ColorController", [{"name": "color"}]))
        eps.append({"endpointId": d["id"], "friendlyName": d.get("deviceName") or "Vont",
                    "description": f"Vont {model}", "manufacturerName": "Vont",
                    "displayCategories": ["LIGHT"] if _is_bulb(model) else ["SMARTPLUG"],
                    "cookie": {"productId": d["productId"], "uid": d["gatewayUid"],
                               "model": model},
                    "capabilities": caps})
    return {"event": {"header": _header("Alexa.Discovery", "Discover.Response"),
                      "payload": {"endpoints": eps}}}


# -------------------------------------------------------------- Alexa control
def _header(ns, name, corr=None):
    h = {"namespace": ns, "name": name, "payloadVersion": "3",
         "messageId": str(uuid.uuid4())}
    if corr:
        h["correlationToken"] = corr
    return h


def _resp(directive, ns, prop, value):
    return {"context": {"properties": [{
        "namespace": ns, "name": prop, "value": value,
        "timeOfSample": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "uncertaintyInMilliseconds": 1000}]},
        "event": {"header": _header("Alexa", "Response",
                                    directive["header"].get("correlationToken")),
                  "endpoint": directive["endpoint"], "payload": {}}}


def _err(directive, etype, msg):
    return {"event": {"header": _header("Alexa", "ErrorResponse",
                                        directive["header"].get("correlationToken")),
                      "endpoint": directive.get("endpoint", {}),
                      "payload": {"type": etype, "message": msg}}}


def lambda_handler(event, context):
    directive = event["directive"]
    ns = directive["header"]["namespace"]
    name = directive["header"]["name"]
    try:
        if ns == "Alexa.Discovery":
            return _discover()
        sess = _login()
        ck = directive["endpoint"]["cookie"]
        pid, uid = ck["productId"], ck["uid"]
        if ns == "Alexa.PowerController":
            on = name == "TurnOn"
            _set_power(sess, pid, uid, on)
            return _resp(directive, "Alexa.PowerController", "powerState",
                         "ON" if on else "OFF")
        if ns == "Alexa.BrightnessController":
            pct = int(directive["payload"]["brightness"])
            _set_power(sess, pid, uid, True)
            _set_brightness(sess, pid, uid, pct)
            return _resp(directive, "Alexa.BrightnessController", "brightness", pct)
        if ns == "Alexa.ColorController":
            hsb = directive["payload"]["color"]
            r, g, b = colorsys.hsv_to_rgb(hsb["hue"] / 360.0, hsb["saturation"],
                                          hsb["brightness"])
            _set_power(sess, pid, uid, True)
            _set_color(sess, pid, uid, int(r * 255), int(g * 255), int(b * 255))
            return _resp(directive, "Alexa.ColorController", "color", hsb)
        if ns == "Alexa" and name == "ReportState":
            return _resp(directive, "Alexa.PowerController", "powerState", "ON")
        return _err(directive, "INVALID_DIRECTIVE", f"no soportado: {ns}/{name}")
    except Exception:
        logger.exception("fallo manejando %s/%s", ns, name)
        return _err(directive, "INTERNAL_ERROR", "internal error")
