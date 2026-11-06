"""Cliente de la nube Topband T-Smart (marca Vont). Protocolo extraído del APK.

Todo lo aquí codificado viene de com.vont.smartlight / com.topband.* del APK oficial:
- Login REST con token Bearer-crudo en cabecera Authorization.
- Control de dispositivos por MQTT sobre TLS (publicando data points).
Ver PROTOCOL.md para el detalle y de dónde salió cada constante.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import ssl
import threading
import time
import uuid
from dataclasses import dataclass, field

import requests

_SECRET_KEY = re.compile(r"token|password|secret|refresh|session", re.I)
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")  # productId/uid válidos (evita inyección en el topic)


def _redact(obj):
    """Copia de un JSON con los valores sensibles enmascarados (para mensajes de error)."""
    if isinstance(obj, dict):
        return {k: ("***" if _SECRET_KEY.search(k) else _redact(v)) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_redact(v) for v in obj]
    return obj

# --- Constantes de la cuenta/empresa (AndroidManifest + código del APK) ---
COMPANY_ID = "e1288ab93107470daf3f7bc3499654d9"
PROJECT_ID = "6512219a33df427cbd59ea300818701c"

USER_API = "https://us-tsmart-user-api.topband-cloud.com/tsmart-user-api"
DEVICE_API = "https://us-tsmart-device-api.topband-cloud.com/tsmart-device-api"

MQTT_HOST = "us-tsmart-mqtt.topband-cloud.com"
MQTT_PORT = 8883  # TLS, cert raíz DigiCert (CA pública: TLS estándar sirve)

LOGIN_PATH = "/appLogin/v2/login"
DEVICE_ALL_PATH = "/device/all"
DATAPOINT_LIST_PATH = "/device/dataPoint/list"


def _md5(text: str) -> str:
    return hashlib.md5(text.encode()).hexdigest()


def _headers(token: str | None = None) -> dict:
    h = {
        "Content-Type": "application/json",
        "App-Project-Id": PROJECT_ID,
        "Accept-Language": "en-US",
    }
    if token:
        h["Authorization"] = token  # crudo, sin "Bearer " (así lo hace la app)
    return h


class TopbandError(RuntimeError):
    pass


@dataclass
class Session:
    token: str
    refresh_token: str
    user_id: str
    raw: dict = field(default_factory=dict)

    def save(self, path: str) -> None:
        data = json.dumps({"token": self.token, "refresh_token": self.refresh_token,
                           "user_id": self.user_id})
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(data)

    @classmethod
    def load(cls, path: str) -> "Session":
        with open(path) as f:
            d = json.load(f)
        return cls(d["token"], d.get("refresh_token", ""), d["user_id"])


def login(username: str, password: str) -> Session:
    """POST /appLogin/v2/login con password=MD5(pw). Devuelve token + userId."""
    body = {"userName": username, "password": _md5(password), "companyId": COMPANY_ID}
    r = requests.post(USER_API + LOGIN_PATH, headers=_headers(), json=body, timeout=15)
    try:
        data = r.json()
    except ValueError:
        raise TopbandError(f"Respuesta no-JSON ({r.status_code}): {r.text[:300]}")
    # La API envuelve en {code,msg,data} o {result,...}. Buscamos el token donde esté.
    payload = data.get("data", data) if isinstance(data, dict) else {}
    token = payload.get("token") or data.get("token")
    if not token:
        raise TopbandError(f"Login sin token. Respuesta (redactada):\n{json.dumps(_redact(data), indent=2)[:800]}")
    return Session(
        token=token,
        refresh_token=payload.get("refreshToken", ""),
        user_id=str(payload.get("userId") or payload.get("uid") or ""),
        raw=data,
    )


def get_devices(s: Session) -> list[dict]:
    """GET/POST /device/all -> lista de dispositivos (productId, uid, deviceId, nombre)."""
    r = requests.post(DEVICE_API + DEVICE_ALL_PATH, headers=_headers(s.token),
                      json={}, timeout=15)
    data = r.json()
    payload = data.get("data", data)
    if isinstance(payload, dict):
        # la API devuelve {data:{rows:[...]}}; otras variantes por si acaso
        for key in ("rows", "list", "deviceList", "devices"):
            if key in payload:
                return payload[key]
        # aplanar familias
        devs = []
        for fam in payload.get("familyList", []) or []:
            devs += fam.get("deviceList", []) or []
        if devs:
            return devs
    if isinstance(payload, list):
        return payload
    raise TopbandError(f"No pude leer la lista. Respuesta (redactada):\n{json.dumps(_redact(data), indent=2)[:800]}")


def get_datapoints(s: Session, product_id: str) -> list[dict]:
    r = requests.post(DEVICE_API + DATAPOINT_LIST_PATH, headers=_headers(s.token),
                      json={"productId": product_id}, timeout=15)
    data = r.json()
    return data.get("data", data)


# --------------------------- MQTT (control) ---------------------------
import paho.mqtt.client as mqtt

_SERIAL = [0]
def _serial() -> str:
    _SERIAL[0] += 1
    return f"{int(time.time()*1000)}{_SERIAL[0]:03d}"


class Controller:
    """Conexión MQTT autenticada con el token. Publica data points a los aparatos."""

    def __init__(self, s: Session):
        self.s = s
        self.connected = threading.Event()
        self._messages: list[tuple[str, bytes]] = []
        # clientId aleatorio no-vacío: el broker rechaza el vacío pero acepta
        # cualquier id para publicar comandos; aleatorio evita colisiones entre
        # peticiones y no expulsa la sesión de la app del móvil.
        cid = "vb-" + uuid.uuid4().hex[:16]
        self.cli = mqtt.Client(client_id=cid, protocol=mqtt.MQTTv311, transport="tcp")
        self.cli.username_pw_set(f"app/{s.token}", s.token)
        self.cli.tls_set(cert_reqs=ssl.CERT_REQUIRED, tls_version=ssl.PROTOCOL_TLS_CLIENT)
        self.cli.on_connect = self._on_connect
        self.cli.on_message = self._on_message

    def _on_connect(self, client, userdata, flags, rc):
        if rc == 0:
            self.connected.set()
        else:
            print(f"[MQTT] conexión rechazada rc={rc}")

    def _on_message(self, client, userdata, msg):
        self._messages.append((msg.topic, msg.payload))

    def connect(self, timeout=15):
        self.cli.connect(MQTT_HOST, MQTT_PORT, keepalive=30)
        self.cli.loop_start()
        if not self.connected.wait(timeout):
            raise TopbandError("MQTT no conectó (token/usuario o TLS)")

    def watch(self, product_id: str, uid: str):
        self.cli.subscribe(f"{product_id}/{uid}/upload/point/data", qos=0)
        self.cli.subscribe(f"{self.s.user_id}/business/response", qos=1)

    def send_datapoint(self, product_id: str, uid: str, attrs: list[dict], mac: str = ""):
        """Publica un comando (method=command) a {productId}/{uid}/download/point/data.

        attrs: lista de data points, p.ej. [{"i": 1, "t": 1, "v": True}]
        """
        if not (_ID_RE.match(product_id) and _ID_RE.match(uid)):
            raise TopbandError("productId/uid inválidos")
        payload = {
            "method": "command",
            "common": {
                "timestamp": int(time.time() * 1000),
                "serial": _serial(),
                "productId": product_id,
                "uid": uid,
            },
            "data": [{"mac": mac, "cmd": 99, "command": attrs}],
        }
        topic = f"{product_id}/{uid}/download/point/data"
        self.cli.publish(topic, json.dumps(payload).encode(), qos=0)
        return payload

    # Tipos de data point (DataTypeEnum del APK): BOOL=9, BYTE=1, SHORT=4, INT=5, FLOAT=6
    BOOL, BYTE, SHORT, INT, FLOAT = 9, 1, 4, 5, 6

    # Índices de data point confirmados en vivo (bombillo SLB01; ver PROTOCOL.md):
    DP_POWER = 1       # bool
    DP_COLOR = 6       # int, RGB empaquetado (0xRRGGBB)
    DP_BRIGHTNESS = 7  # byte, 0..100

    def set_power(self, product_id: str, uid: str, on: bool, mac: str = ""):
        """Enciende/apaga. power = índice 1, booleano. OJO: el valor va como booleano
        JSON (true/false), NO como 1/0 (con 1 el device ignora el encendido). El mac
        va vacío para bombillos/enchufes wifi directos (no sub-dispositivos de gateway)."""
        return self.send_datapoint(product_id, uid,
                                   [{"i": self.DP_POWER, "t": self.BOOL, "v": bool(on)}], mac=mac)

    def set_brightness(self, product_id: str, uid: str, pct: int, mac: str = ""):
        """Brillo 0..100 (byte)."""
        pct = max(0, min(100, int(pct)))
        return self.send_datapoint(product_id, uid,
                                   [{"i": self.DP_BRIGHTNESS, "t": self.BYTE, "v": pct}], mac=mac)

    def set_color(self, product_id: str, uid: str, r: int, g: int, b: int, mac: str = ""):
        """Color RGB empaquetado en un int (0xRRGGBB)."""
        rgb = (int(r) & 255) << 16 | (int(g) & 255) << 8 | (int(b) & 255)
        return self.send_datapoint(product_id, uid,
                                   [{"i": self.DP_COLOR, "t": self.INT, "v": rgb}], mac=mac)

    def disconnect(self):
        self.cli.loop_stop()
        self.cli.disconnect()
