# Vont/Topband — formatos de cada función (extraídos del APK)

Rutas de código relativas a `src/sources/com/topband/` del APK descompilado.
Tipos de data point (dp): BOOL=9, BYTE=1, SHORT=4, INT=5, SIGNED_BYTE=7, BYTE_ARRAY=8.
Comandos MQTT: ver PROTOCOL.md (`{productId}/{uid}/download/point/data`, `mac:""`, `cmd:99`).
BYTE_ARRAY se manda como `v` = string hex (Tools.bytesToHexString), BOOL como `true/false`.

## 0. Hosts

| Host | Uso | Estado |
|---|---|---|
| `USER_API` us-tsmart-user-api…/tsmart-user-api | login, `/family/list` | vivo |
| `DEVICE_API` us-tsmart-device-api…/tsmart-device-api | device/*, family/device/* | vivo |
| `https://www.vonthome.com/vont-back` (`HttpManage.BaseURL`, base/net/HttpManage.java:74) | escenas/horarios en nube, DIY, colores guardados | **MUERTO**: devuelve una landing HTML (probado 2026-11-04) |

`familyId`: `POST USER_API/family/list` body `{}` → `data[0].id` (tsmart/cloud/TSmartFamily.java:218).
Verificado en vivo (familia "My home").

## 1. Renombrar aparato

`POST DEVICE_API/device/name/modify` — tsmart/cloud/TSmartDevice.java:361-366
```json
{ "familyId": "<familyId>", "deviceId": "<device.id>", "deviceName": "<nuevo>" }
```

## 2. Desvincular / eliminar aparato

`POST DEVICE_API/family/device/unbind/v2` — TSmartDevice.java:390-394
```json
{ "familyId": "<familyId>", "uid": "<gatewayUid>" }
```
Irreversible sin volver a emparejar por BLE (ver §8). No probado en vivo.

## 3. Online + estado actual

`POST DEVICE_API/device/v2/detail` `{ "deviceId": "<id>" }` (TSmartDevice.java:343). Respuesta `data`:
- `deviceFields.online` (1/0) y también `data.online`; `deviceFields.signal` (RSSI), `updateTime`.
- `pointDataMap`: `{ <pointName>: { pointIndex, pointType, value } }` — estado actual de cada dp
  (values como string: `"true"`, `"100"`, hex para BYTE_ARRAY). Usar esto para pintar la UI y
  para resolver índice/tipo por nombre (no hardcodear).
- `dataPointEnums` (vía `/device/v2/data_point/detail`) solo trae enumeraciones.

Tiempo real en la app: subscribe `{productId}/{uid}/upload/point/data` (cambios de dp, `cmd:98`,
`command` como objeto por nombre) y `method:"online"` en `{userId}/business/response/v2`
(AppMqtt.java:115, 283 → deviceOnlineStatue). En nuestras pruebas el broker sólo entrega la
telemetría de forma fiable a la sesión principal, así que para una web basta con **re-leer
`/device/v2/detail`** tras cada comando y con un poll cada ~15-30 s.

### Mapas de dp verificados en vivo (pointDataMap)

SLB01 (product 2cfe78a9…): 1 power_onoff BOOL · 2 work_mode BYTE · 4 scence_id BYTE ·
5 general_timer BYTE_ARRAY(6) · 6 color_data INT · 7 brightness BYTE · 10 DIY_scene BYTE_ARRAY(122) ·
11 warm_switch BOOL · 104 wakeup BYTE_ARRAY(5) · 105 sleeping BYTE_ARRAY(6) · 106 vacation_mode BOOL

SLB04-RCWV1 (product 6ad269d0…): igual que SLB01 + 8 auto_color_switch BYTE · 9 music_state BYTE ·
**12 temp_value SHORT** · 101 device_reset BOOL

SP01 enchufe (product 4d453c7d…): 1 power_onoff BOOL · 2 Vacation_mode BYTE · 3 Plug_status_light BOOL ·
4 Timer_message BYTE_ARRAY(5) · 5 Auto_message BYTE_ARRAY(6) · 6 working_times BYTE_ARRAY (solo lectura) ·
7 Wifi_RSSI SIGNED_BYTE (lectura) · 8 Device_Reset BOOL (¡reset de fábrica, no exponer!)

## 4. Horarios

### 4a. Horarios en la NUBE — NO usables
`/scheduleScene/{list,detail,save,delete,switch}` y `/scene/power_color/*`, `/scene/schedule/*`
(base/net/HttpManage.java:118-185, 670-805) viven en `vonthome.com/vont-back` → **muerto**.
Referencia de formato (por si revive): `saveScheduleScene` body
`{id?, familyId, sceneName, repeatDay:"2,3,4", enable:bool, timePointList:[{time:"HH:mm", sort, actionList:[{deviceId,productId,uid,extAddr,command:"[{i,t,v}]"}]}], timeZone:int horas}`;
`ruleEditTimer` (`/scene/power_color/timer/update`): `{timerId, sceneId, familyId, time:"HH:mm", sort, timeZone, repeatDay, timingType:1=on/0=off, enable:1/0, command:"[{\"i\":1,\"t\":9,\"v\":true}]"}`.
repeatDay de nube = lista separada por comas, domingo=1 … sábado=7 (WeekAdapter.getRepeatString:156).
`/device/task/*` (DEVICE_API) acepta tareas cron pero el servidor no las ejecuta (probado).

### 4b. Temporizador en el aparato — SÍ funciona (lo guarda el firmware)

**Máscara de días (1 byte)** — WeekAdapter.getRepeatInt:145 y TimeUtils.getRepeatString:195:
bit0=domingo, bit1=lunes, bit2=martes, bit3=miércoles, bit4=jueves, bit5=viernes, bit6=sábado
(`0x7F` = todos los días, `0` = una sola vez).

**Bombillo — `general_timer` dp 5, BYTE_ARRAY 6 bytes** — tsmart/device/vm/light/DeviceDetailsVM.java:642-667
```
byte0      = repeatMask | 0x80 si el temporizador está activado
byte1..2   = minuto de inicio desde 00:00 (big-endian)
byte3..4   = minuto de fin (big-endian)
byte5      = timerType: 01 = encender al inicio / apagar al fin ("rb_on")
                        00 = apagar al inicio / encender al fin ("rb_off")
```
Ej. real `00007D008C00` = desactivado, 02:05→02:20, tipo off. Un solo horario por aparato.
(Lectura inversa en DeviceDetailsActivity.java:2140-2166.)

**Enchufe — `Timer_message` dp 4, BYTE_ARRAY 5 bytes** — tsmart/device/vm/soket/SoketDetailVm.java:361-378
```
byte0      = repeatMask (sin bit 0x80)
byte1..2   = minuto del día (big-endian)
byte3      = timerType: 01 = encender, 00 = apagar
byte4      = enable: 01/00
```
Ej. real `7F04920101` = todos los días 19:30 encender, activo.

**Enchufe — cuenta regresiva `Auto_message` dp 5, BYTE_ARRAY 6 bytes** — SoketDetailVm.java:381-390
```
byte0      = enable 01/00
byte1      = timerType 01 = encender / 00 = apagar al terminar
byte2..5   = instante final en epoch UNIX segundos (big-endian) = ahora + minutos*60
```
Ej. real `010068D4A851`.

`wakeup` (104) y `sleeping` (105): existen en el firmware pero el APK no los escribe en ningún
lado (no hay encoder) → no soportados.

## 5. Blanco cálido / frío

- `warm_switch` dp 11 BOOL = modo blanco (true) vs color (false).
- Modo blanco + brillo: `[ {i:7,t:1,v:brillo}, {i:11,t:9,v:true} ]` — DeviceDetailsVM.setWarmColor:830-865.
- Volver a color: `{i:11,t:9,v:false}` + `{i:6,t:5,v:rgb}` (sendColorToDevice:900-916).
- **Temperatura (solo SLB04-RCWV1, tiene dp 12):** `[ {i:12,t:4,v:N}, {i:11,t:9,v:true} ]`
  — DeviceDetailsVM.setWarmLight:868-881. Rango no visible en el código (viene de un slider);
  probar 0..100 (valor actual 0). El SLB01 no tiene dp 12: solo blanco on/off + brillo.

## 6. Modos, escenas, música, DIY

`work_mode` dp 2 BYTE — DeviceDetailsVM.setWorkMode:573-626 (usos en UI: 1, 2, 3, 4):
1 = blanco/normal, 2 = color, 3 = escena (manda también dp4 `scence_id`, por defecto 6),
4 = DIY (manda también dp10). Si `warm_switch` está activo lo apaga primero.

`scence_id` dp 4 BYTE (DeviceDetailsVM.setScene:1032), lista de assets/*.json:
- Emoción: Vivid=1, Relax=3, Breathe=5, Happy=40, Enthusiastic=41, Excited=42, Active=43, Warm=44, Quiet=45, Profound=46, Longing=47, Dreamland=48
- Vida: Reading=2, Romantic=4, Sweet=30, Dating=31, Twinkle=32, Sports=33, Game=34, Movie=35, Study=36, Business=37, Work=38, Fight=39
- Festivos: Party=19, Candlelight=20, Christmas=21, Halloween=22, Ghost=23, Valentine=24, Mother=25, Father=26, Thanksgiving=27, Dance Party=28, Disco=29
- Naturaleza: Sunrise=6, Sunset=7, Aurora=8, Dusk=9, Glow=10, Star=11, Lightning=12, Spring=13, Summer=14, Fall=15, Winter=16, Forest=17, River=18

Enviar escena: `[ {i:2,t:1,v:3}, {i:4,t:1,v:<id>} ]`.

Música (solo SLB04, usa el micrófono del teléfono → no aplica a web): `auto_color_switch` dp 8 BYTE 1/0
(setAutoColorSwitch2:1096), `music_state` dp 9 BYTE (1107), sensibilidad dp 3 BYTE (1113, no está en el
pointDataMap de estos modelos).

DIY dp 10 BYTE_ARRAY 122 bytes — DeviceDetailsVM.getDiyAttribute:927-960:
`[style 1B][speed 1B][30 × color 4B = 00RRGGBB]`, colores sobrantes `00000000`. Enviar con `{i:2,v:4}`.

## 7. Enchufe SP01

| dp | nombre | tipo | escritura (SoketDetailVm.java) |
|---|---|---|---|
| 1 | power_onoff | BOOL | powerSwitch:340 |
| 2 | Vacation_mode | BYTE 1/0 | powerHoliday:347 (modo vacaciones = encendido aleatorio) |
| 3 | Plug_status_light | BOOL | lightSwitch:354 (LED del enchufe) |
| 4 | Timer_message | BYTE_ARRAY | horario, §4b |
| 5 | Auto_message | BYTE_ARRAY | cuenta regresiva, §4b |
| 6 | working_times | BYTE_ARRAY | lectura |
| 7 | Wifi_RSSI | SIGNED_BYTE | lectura |
| 8 | Device_Reset | BOOL | reset de fábrica — no exponer |

Consumo/tiempo de uso: `getDeviceRunData` en vonthome (`/device/data/get`) → muerto.

## 8. Agregar aparato nuevo

Flujo de la app (BaseSearchBleActivity, WifiSettingVM.java:255-290):
1. Escaneo **BLE** del aparato en modo emparejamiento.
2. Por BLE: `sendData(121, ssid+password)` (credenciales Wi-Fi) y `sendData(13, Constant.deviceURL)`
   (URL del broker MQTT).
3. El aparato entra al Wi-Fi y se registra en Topband; la app lo liga a la familia con
   `POST DEVICE_API/family/device/bind/v2` `{familyId, roomId, uid, longitude, latitude, checkOnline}`
   (TSmartDevice.java:445-456).

Desde web: solo vía **Web Bluetooth** (Chrome escritorio/Android; no iOS Safari) y requiere
reconstruir el framing de paquetes de `BleDeviceManager` (no extraído aquí). Alternativa práctica:
emparejar con la app Vont (sigue funcionando) o con un script local; luego aparece en `/device/all`.
