#!/usr/bin/env python3
"""Proof de control de la nube Vont/Topband. Uso:

  python cli.py login            # pide tu cuenta Vont, guarda el token en token.json
  python cli.py devices          # lista tus aparatos (productId, uid, nombre)
  python cli.py dp <productId>   # lista los data points de ese producto
  python cli.py watch <productId> <uid>        # escucha el estado real del aparato
  python cli.py on  <productId> <uid> [dp]     # enciende (dp = índice del punto, def 1)
  python cli.py off <productId> <uid> [dp]

La contraseña se pide en el momento (getpass) y NUNCA se guarda; solo se guarda el token.
"""
import getpass
import json
import sys
import time

from bridge import topband

TOKEN_FILE = "token.json"


def _session() -> topband.Session:
    try:
        return topband.Session.load(TOKEN_FILE)
    except FileNotFoundError:
        sys.exit("No hay sesión. Corre primero:  python cli.py login")


def cmd_login():
    user = input("Correo de tu cuenta Vont: ").strip()
    pw = getpass.getpass("Contraseña (no se mostrará ni se guardará): ")
    s = topband.login(user, pw)
    s.save(TOKEN_FILE)
    print(f"OK. token guardado en {TOKEN_FILE}. userId={s.user_id or '(vacío)'}")


def cmd_devices():
    s = _session()
    devs = topband.get_devices(s)
    print(f"{len(devs)} dispositivo(s):\n")
    for d in devs:
        print(json.dumps(d, indent=2, ensure_ascii=False))
        print("-" * 40)


def cmd_dp(product_id):
    s = _session()
    print(json.dumps(topband.get_datapoints(s, product_id), indent=2, ensure_ascii=False))


def cmd_watch(product_id, uid):
    s = _session()
    c = topband.Controller(s)
    c.connect()
    c.watch(product_id, uid)
    print("Conectado. Escuchando 30s… mueve el aparato desde la app para ver su estado.")
    end = time.time() + 30
    seen = 0
    while time.time() < end:
        if len(c._messages) > seen:
            for t, p in c._messages[seen:]:
                print(f"\n[{t}]\n{p.decode(errors='replace')}")
            seen = len(c._messages)
        time.sleep(0.3)
    c.disconnect()


def cmd_power(on, product_id, uid):
    s = _session()
    c = topband.Controller(s)
    c.connect()
    print("MQTT conectado.")
    payload = c.set_power(product_id, uid, on)
    print(f"Enviado ({'ON' if on else 'OFF'}):\n{json.dumps(payload, ensure_ascii=False)}")
    time.sleep(2)
    c.disconnect()


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    cmd, args = sys.argv[1], sys.argv[2:]
    if cmd == "login":
        cmd_login()
    elif cmd == "devices":
        cmd_devices()
    elif cmd == "dp":
        cmd_dp(*args)
    elif cmd == "watch":
        cmd_watch(*args)
    elif cmd == "on":
        cmd_power(True, *args)
    elif cmd == "off":
        cmd_power(False, *args)
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
