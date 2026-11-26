# Placa ESP32 (puente Bluetooth)

Para aparatos sin nube que se controlan por Bluetooth. La placa le pide órdenes al API
(`/api/hub/poll`) y las ejecuta:

- **Abanico/lámpara con receptor ZhiMei** (app "Zhi Mei Deng Kong", versión `fan_v0`): anuncios BLE.
  Protocolo descifrado por [ha-ble-adv](https://github.com/NicoIIT/ha-ble-adv).
- **Tiras LED ELK-BLEDOM** (app "Lotus Lantern"): escritura GATT en `FFF3`.

Probado con una ESP32-WROOM-32 (con o sin pantalla OLED SSD1306 en SDA 21 / SCL 22).
La tira necesita la placa cerca (2–3 m): con señal débil no acepta la conexión.

## Instalar y configurar

En la app: **menú → Placas ESP32 → Nueva placa**. Eso da un código de 6 dígitos. Luego:

- **Por cable (Chrome/Edge de computadora):** "Configurar por cable USB" instala MicroPython,
  copia estos archivos y la configuración.
- **Sin cable:** con el firmware ya instalado y sin configurar (o tras mantener **BOOT** 5 s), la
  placa crea la red `NotVontEG-XXXX`; conéctate desde el teléfono, elige tu Wi-Fi y pon el código.

La contraseña del Wi-Fi va directo a la placa; nunca pasa por el servidor.

## Archivos

| Archivo | Qué es |
| --- | --- |
| `main.py` | Programa principal: Wi-Fi, canje del código, órdenes por Bluetooth |
| `setup.py` | Red de configuración con portal cautivo |
| `screen.py` | Pantalla OLED (opcional) |
| `ssd1306.py` | Controlador de la pantalla, de [micropython-lib](https://github.com/micropython/micropython-lib) (MIT) |
| `firmware/*.bin` | [MicroPython](https://micropython.org) v1.29 para ESP32 (MIT), sin cambios |
| `config.example.json` | Forma del `config.json` que escribe la configuración |
