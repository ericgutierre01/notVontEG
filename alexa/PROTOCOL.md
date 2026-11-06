# Protocolo Vont / Topband T-Smart (ingeniería inversa del APK)

APK analizado: `com.vont.smartlight` (sacado del Samsung A10e del usuario, Android 9).
La marca **Vont** cerró, pero los aparatos usan la nube **Topband** (`topband-cloud.com`,
plataforma "T-Smart"), que sigue operativa. Objetivo: puente propio → Alexa, 100% en la nube.

## Constantes (de AndroidManifest.xml y del código)

| Qué | Valor |
|-----|-------|
| companyId | `e1288ab93107470daf3f7bc3499654d9` |
| projectId | `6512219a33df427cbd59ea300818701c` |
| User API | `https://us-tsmart-user-api.topband-cloud.com/tsmart-user-api` |
| Device API | `https://us-tsmart-device-api.topband-cloud.com/tsmart-device-api` |
| MQTT | `us-tsmart-mqtt.topband-cloud.com:8883` (TLS, raíz DigiCert → CA pública) |

## Autenticación REST

- **Login:** `POST {USER_API}/appLogin/v2/login`
  - body JSON: `{ "userName": <correo>, "password": MD5(<contraseña>), "companyId": COMPANY_ID }`
  - headers: `Content-Type: application/json`, `App-Project-Id: {projectId}`
  - respuesta: `token`, `refreshToken`, `userId` (envueltos en `data` según la API).
- **Peticiones autenticadas:** cabecera `Authorization: <token>` (token CRUDO, sin "Bearer ").
  (`com.topband.tsmart.cloud.BaseApi`, `HttpBaseParam.PARAM_AUTHORIZATION`).
- No hay firma HMAC por petición. `libCheckSignature.so` es solo anti-piratería
  (verifica el cert de firma del propio APK); no firma el tráfico de red.

## Dispositivos (REST)

- Lista: `POST {DEVICE_API}/device/all` (con Authorization).
- Data points de un producto: `POST {DEVICE_API}/device/dataPoint/list` body `{productId}`.
- Cada dispositivo trae `productId`, `uid`/`deviceUid`, `deviceId`, `extAddr` (mac), nombre.

## Control (MQTT)

`com.topband.tsmart.AppMqtt` (conexión real, tras login):

- clientId = `userId`  ← **obligatorio exacto**. Con cualquier sufijo, el broker
  deniega `business/response` (SUBACK qos 0x80) y NO enruta los comandos al aparato.
  Coste: la app del móvil se desconecta mientras el puente está conectado (reconecta
  sola). Aceptable para un puente que conecta por ráfagas al recibir orden de Alexa.
- username = `"app/" + token`
- password = `token`
- (La derivación con SHA1 del cert + AES es solo de `NoAccountMqtt`, el escaneo QR
  pre-login. La conexión autenticada NO la usa.)

### Publicar un comando (encender/apagar/color)

- Topic: `{productId}/{uid}/download/point/data`
- Payload JSON (`method=command`):

```json
{
  "method": "command",
  "common": { "timestamp": <ms>, "serial": "<serial>", "productId": "<pid>", "uid": "<uid>" },
  "data": [ { "mac": "<extAddr o ''>", "cmd": 99, "command": [ <TBAttribute>, ... ] } ]
}
```

- **TBAttribute** = `{ "i": <índice dp>, "t": <tipo>, "v": <valor> }`
  - tipos (`DataTypeEnum`): BOOL=9, BYTE=1, SIGNED_SHORT=2, SIGNED_INT=3, SHORT=4,
    INT=5, FLOAT=6, SIGNED_BYTE=7, BYTE_ARRAY=8, VARCHAR=0.
  - **`mac` debe ir VACÍO** (`""`) para bombillos/enchufes wifi directos. Con el
    `extAddr` puesto, el device ignora el comando. (extAddr sirve solo para
    sub-dispositivos detrás de un gateway real.)
  - **Para BOOL, `v` va como booleano JSON `true`/`false`, NO como `1`/`0`.** Con `0`
    sí apaga, pero con `1` NO enciende; hay que mandar `true`. Verificado en vivo.

### Data points confirmados en vivo (bombillo SLB01, product 2cfe78a9...)

Capturados por REST `/device/v2/data_point/detail {deviceId}` y por telemetría
`upload/point/data` (reporte del device, `cmd:98`, `command` como objeto con nombres):

| dp | i | t (tipo) | descripción | valor |
|----|---|----------|-------------|-------|
| power_onoff | 1 | 9 BOOL | encendido | true/false |
| work_mode | 2 | 1 BYTE | modo | |
| sensitivity | 3 | 1 BYTE | sensibilidad música | |
| scence_id | 4 | 1 BYTE | escena | |
| DIY_scene | 5 | 8 BYTE_ARRAY | efecto DIY | hex |
| color_data | 6 | 5 INT | color RGB empaquetado | 0xRRGGBB |
| brightness | 7 | 1 BYTE | brillo | 0..100 |
| music_switch | 8 | 1 BYTE | música on/off | |
| music_state | 9 | 1 BYTE | | |
| warm_switch | 11 | 9 BOOL | luz cálida | true/false |

Fuente en el APK: `DeviceDetailsVM.powerSwitch/setColor/setBrightness1/...`.

### Escuchar estado

- Subscribe `{productId}/{uid}/upload/point/data` (reportes del aparato).
- Subscribe `{userId}/business/response` (respuestas a comandos).

## Estado del proyecto

1. [x] Protocolo descifrado (este doc).
2. [x] Proof: login + listar + encender/apagar un bombillo real (`cli.py`). **FUNCIONA.**
3. [x] Índices de data points de la luz (power/brillo/color). Confirmados.
4. [ ] AWS Lambda (Smart Home skill) que traduzca directivas Alexa → `send_datapoint`.
5. [ ] Skill de Alexa + account linking (OAuth contra login de Topband).

## Restricción operativa importante

El broker entrega telemetría y acepta control SOLO en la sesión cuyo `clientId == userId`,
y solo puede haber UNA. Por eso el puente y la app del móvil **no pueden estar conectados
a la vez**: cada uno expulsa al otro. Para un puente de Alexa (conexión por ráfagas al
recibir una orden) es aceptable; la app del móvil reconecta sola al terminar.

## Vinculación Alexa que traía la app (referencia)

- skillStage: `development` (por eso dejó de funcionar; no está en la tienda pública).
- Nuestra skill propia reemplaza esto por completo.
