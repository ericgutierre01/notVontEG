# Vont/Topband — emparejar un aparato nuevo por Bluetooth (Web Bluetooth) y vincularlo

Fuente: APK `com.vont.smartlight` decompilado (rutas relativas a `sources/`). Verificado en vivo
lo marcado con ✅. Lo demás es lectura de código, sin probar contra un aparato.

## Resumen del flujo de la app

1. Escaneo BLE → anuncio con nombre `Vont*` o `T-Smart_*` y datos de fabricante "TB".
2. Conecta GATT (servicio `FFE0`), pide MTU 250, activa notificaciones en `FFE1`.
3. 1 s después de conectar: **cmd 135** sincroniza hora.
4. **Vincula en la nube** (`/family/device/bind/v2`) con `uid = MD5(productId + mac)`. Sin esperar Wi-Fi (`checkOnline: 0`).
5. Busca el aparato en la lista de la familia, lo pone en blanco, lo renombra.
6. Pantalla de Wi-Fi: al conectar BLE, 500 ms después **cmd 13** (host del broker MQTT); luego **cmd 121** (SSID + clave).
   El aparato responde **cmd 121** = recibido; la app espera a que el aparato aparezca *online* y desconecta BLE.

Citas: `com/topband/tsmart/ui/configure/searchBleDevice/BaseSearchBleActivity.java:720-749,840-890`,
`com/topband/tsmart/vm/AddDviceVm.java:104-160,186-218`,
`com/topband/tsmart/device/ui/setting/network/wifiSetting/WifiSettingActivity.java:290-345,381-425`,
`com/topband/tsmart/device/vm/setting/WifiSettingVM.java:259-290`.

## 1. Escaneo / anuncio

`BaseSearchBleActivity.onParseData:971-1040` + `com/topband/lib/ble/util/BleBaseUtil.java:120-178`:

- `localName` empieza por **`T-Smart_`** o **`Vont`** (igual para SLB01, SLB04, SP01).
- AD tipo `0xFF` (fabricante) de **16 bytes**, *incluyendo* los 2 bytes de "company id":

| bytes | contenido |
|---|---|
| 0..1 | `"TB"` ASCII (0x54 0x42) — obligatorio |
| 2..5 | `productCode` uint32 **big-endian** (decimal, ver tabla) |
| 6..11 | MAC Wi-Fi del aparato (= `extAddr`), hex en minúsculas, sin `:` |
| 12..15 | flags; `canBind = (byte12 & 0x10) != 0` (modo emparejamiento) |

**En Web Bluetooth** el mapa `manufacturerData` usa como clave el company id little-endian:
`"TB"` → **`companyIdentifier = 0x4254`**, y el `DataView` son los 14 bytes restantes
(`productCode` en offset 0, MAC en 4..9, flags en 10..13).

`productCode` → `productId`: ✅ `POST DEVICE_API/device/app_product_category/list {}` (probado en vivo).
Relevantes: `100108` → `2cfe78a968a549f1a4591b4fd9e2965e` (Bulb Color SLB01/02/03),
`100223` → `6ad269d0b5e24e8f875a69f95926d26d` (Bulb Color Pro SLB04-RCWV1),
`300020` → `4d453c7de94b4d5991a4a5507459a527` (Plug SP01). Caso especial en el APK: `300029` → Light Bars.

## 2. GATT

`com/vont/blelib/BlePackageUtil.java` (static init), `BleDeviceManager.java:135-163`:

- Servicio **`0000ffe0-0000-1000-8000-00805f9b34fb`**
- Escritura **y** notificación en la misma característica **`0000ffe1-0000-1000-8000-00805f9b34fb`**
- Tipo de escritura: por defecto de Android (`WRITE_TYPE_DEFAULT` = con respuesta) — `com/topband/lib/ble/SendRunnable.java`.
  En web: `writeValueWithResponse` si la característica lo soporta, si no `writeValueWithoutResponse`.
- MTU pedido: **250** (`com/vont/blelib/base/BleManager.java:36`, `BluetoothConnectCallback.java:22`).
  **Sin troceo**: cada paquete va en una sola escritura. Web Bluetooth no deja pedir MTU; Chrome lo negocia solo
  (macOS/Android suelen dar ≥185). Los paquetes de alta miden ≤ ~110 bytes.

## 3. Encuadre del paquete (`BlePackageUtil.onPacking/onParsePackage/onPackingAck`)

Todo **big-endian**. Sin cifrado.

```
[0..1]  cabecera 0xAA55
[2..3]  longitud TOTAL del paquete (incluye cabecera y checksum) = payload + 9
[4..5]  serial: empieza en 0xFFFF y DECREMENTA en cada envío (si llega a 0 vuelve a 0xFFFF)
[6]     flag: 0x80 = petición, 0x40 = ack
[7]     cmd
[8..]   payload
[n-1]   checksum = (suma de todos los bytes anteriores ^ 0x33) & 0xFF
```

Ack (lo que la app responde a cada paquete del aparato con flag 0x80, salvo cmd 224/225):
mismo serial y cmd, flag `0x40`, sin payload, longitud 9 (`BleDeviceManager.java:222-226`, `onPackingAck`).

Ejemplos (calculados con el algoritmo exacto):

```
cmd 135 hora (serial FFFF, epoch 1793800000, UTC-4):  AA550011FFFF80876AEB3740FFFFC7C055
cmd 13 broker (serial FFFE):  AA55002EFFFE800D75732D74736D6172742D6D7174742E746F7062616E642D636C6F75642E636F6D3A3838383305
cmd 121 Wi-Fi "Casa"/"12345678" (serial FFFD):  AA550017FFFD8079044361736108313233343536373800
ack de un cmd 129 serial 0001:  AA55000900014081F9
```

## 4. Comandos

| cmd | dirección | payload | cita |
|---|---|---|---|
| **135** | app→aparato | `[epoch segundos int32 BE][offset zona horaria en segundos int32 BE]` | `BleDeviceManager.synchronizationTime:376-386` |
| **13** | app→aparato | host del broker MQTT en UTF-8: `us-tsmart-mqtt.topband-cloud.com:8883` (`Constant.deviceURL`) | `WifiSettingVM.sendWifiMessageToDevice`, `com/topband/base/constant/Constant.java:27` |
| **121** | app→aparato | `[len SSID 1B][SSID UTF-8][len clave 1B][clave UTF-8]` | `WifiSettingVM.sendWifiMessage` |
| **121** | aparato→app | respuesta: Wi-Fi recibido (la app solo mira el cmd, no el payload) | `WifiSettingVM.onDataReceive` |
| 130 | app→aparato | vacío: pide atributos | `BleDeviceManager.getDeviceAttribute` |
| 129/130/131 | aparato→app | reporte de atributos (data points) | `BleDeviceManager.java:234-260` |

No se envía `userId`, token, `companyId` ni código de vinculación por BLE: la identidad es `uid = MD5(productId + mac)`
y la vinculación va por REST. El aparato no devuelve su `uid`; se calcula.

✅ `uid = MD5(productId.lower() + mac.lower().replace(":",""))` coincide con el `gatewayUid` real de los 3
aparatos del usuario (SLB01, SP01, SLB04).

Éxito del Wi-Fi: el aparato aparece `online` (`POST /device/v2/detail` → `deviceFields.online = 1`, o
MQTT `method:"online"`). La app no tiene un código de fallo por BLE; usa un diálogo de 120 s de espera.

## 5. Vincular en la nube

`AddDviceVm.bindDevice:104-160` → `com/topband/base/net/HttpManage.java:187-197`
(¡usa `TSmartEnvironment.getDeviceURL()` = la nube de Topband, viva!, no el backend muerto de Vont):

```
POST https://us-tsmart-device-api.topband-cloud.com/tsmart-device-api/family/device/bind/v2
Authorization: <token>   App-Project-Id: <projectId>
{ "familyId": "<de /family/list → data[0].id>", "uid": "<md5>", "checkOnline": 0,
  "longitude": <double>, "latitude": <double> }
```

- La app exige ubicación (si no hay, no vincula); cualquier lat/long válida sirve.
- Errores: `200203` = el aparato no existe en la nube; `200215` = ya está vinculado a otra cuenta.
- Después: lista de dispositivos de la familia, busca por `uid`, lo pone en blanco y lo renombra.

## 6. Limitaciones desde un navegador

- **Web Bluetooth solo en Chrome/Edge (Mac, Windows, Android, ChromeOS).** Nada en iPhone/iPad.
- **Leer los datos de fabricante del anuncio** (`productCode`, MAC, `canBind`) exige `device.watchAdvertisements()`,
  que en Chrome sigue tras la flag *Experimental Web Platform features*. Sin ella, `requestDevice` sí puede
  **filtrar** por `namePrefix` y `manufacturerData` (`companyIdentifier 0x4254`), pero no te deja leer la MAC.
  Alternativa sin flag: el usuario elige el tipo de aparato y escribe/escoge la MAC (de la etiqueta o, al
  re-emparejar uno conocido, del `extAddr` que ya está en la cuenta).
- `device.id` de Web Bluetooth es aleatorio; **no** es la MAC.
- No hay secretos nativos ni cifrado BLE. No hace falta Bluetooth clásico.
- `200203`: si un aparato nunca se registró en la nube de Topband, el bind podría fallar. No probado.
