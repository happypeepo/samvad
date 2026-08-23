// Thin TS wrapper around the custom native plugin (android/.../SamvadBlePeripheralPlugin.kt)
// that does what @capacitor-community/bluetooth-le cannot: act as a BLE
// *peripheral* — run a GATT server and advertise it. Android's Java/Kotlin
// BluetoothGattServer + BluetoothLeAdvertiser APIs have no browser or
// Capacitor-community equivalent, so this one slice of the BLE tier has to
// be real native code.
import { registerPlugin } from '@capacitor/core'

export const SAMVAD_SERVICE_UUID = '7a1b0001-0000-1000-8000-00805f9b34fb'
export const SAMVAD_RX_CHARACTERISTIC_UUID = '7a1b0002-0000-1000-8000-00805f9b34fb' // central -> peripheral (write)
export const SAMVAD_TX_CHARACTERISTIC_UUID = '7a1b0003-0000-1000-8000-00805f9b34fb' // peripheral -> central (notify)

export interface CentralConnectedEvent {
  deviceId: string
}
export interface CentralWriteEvent {
  deviceId: string
  /** base64 */
  data: string
}

export interface SamvadBlePeripheralPlugin {
  initialize(): Promise<{ supported: boolean }>
  startAdvertising(opts: { localName: string }): Promise<void>
  stopAdvertising(): Promise<void>
  /** Send bytes to a specific connected central via a GATT notification. */
  notify(opts: { deviceId: string; data: string /* base64 */ }): Promise<void>
  addListener(
    eventName: 'centralConnected' | 'centralDisconnected' | 'centralSubscribed',
    listener: (event: CentralConnectedEvent) => void,
  ): Promise<{ remove: () => void }>
  addListener(
    eventName: 'write',
    listener: (event: CentralWriteEvent) => void,
  ): Promise<{ remove: () => void }>
}

export const SamvadBlePeripheral = registerPlugin<SamvadBlePeripheralPlugin>('SamvadBlePeripheral')
