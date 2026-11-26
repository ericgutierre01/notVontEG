# Pantalla OLED de la placa (SSD1306 128x64 por I2C, SDA 21 / SCL 22). Si la placa no tiene, no hace nada.
# La fuente es ASCII: se quitan los acentos. Se apaga sola tras IDLE_S segundos sin cambios.
import time
from machine import Pin, SoftI2C

IDLE_S = 60
_ACC = {"á": "a", "é": "e", "í": "i", "ó": "o", "ú": "u", "ñ": "n", "ü": "u",
        "Á": "A", "É": "E", "Í": "I", "Ó": "O", "Ú": "U", "Ñ": "N", "¿": "", "¡": ""}
_o = None
_last = [time.time(), True]  # último cambio, encendida

try:
    import ssd1306
    _i2c = SoftI2C(sda=Pin(21), scl=Pin(22))
    if 0x3C in _i2c.scan():
        _o = ssd1306.SSD1306_I2C(128, 64, _i2c)
except Exception as e:  # sin pantalla o sin controlador: la placa funciona igual
    print("pantalla", e)


def _ascii(s):
    return "".join(_ACC.get(ch, ch) if ord(ch) < 128 or ch in _ACC else "?" for ch in str(s))


def show(title, *lines):
    """Título arriba con una línea, y hasta 5 renglones de 16 caracteres (los largos se cortan en dos)."""
    if not _o:
        return
    rows = []
    for ln in lines:
        ln = _ascii(ln)
        while ln and len(rows) < 5:
            rows.append(ln[:16])
            ln = ln[16:]
    try:
        _o.poweron()
        _o.fill(0)
        _o.text(_ascii(title)[:16], 0, 0)
        _o.hline(0, 11, 128, 1)
        for i, r in enumerate(rows):
            _o.text(r, 0, 16 + i * 10)
        _o.show()
        _last[0], _last[1] = time.time(), True
    except OSError as e:
        print("pantalla", e)


def tick():
    """Llamar cada segundo: apaga la pantalla tras IDLE_S sin cambios (evita que se queme)."""
    if _o and _last[1] and time.time() - _last[0] > IDLE_S:
        try:
            _o.poweroff()
        except OSError:
            pass
        _last[1] = False
