package org.samvad.app

// The one piece of the BLE mesh tier that has no browser or Capacitor-
// community equivalent: acting as a BLE *peripheral* — running a GATT
// server and advertising it, so another SAMVAD phone can find and connect
// to us without either device needing a companion app or paired hardware.
// (@capacitor-community/bluetooth-le, like Web Bluetooth, is Central-only.)
//
// GATT profile:
//   Service:            SAMVAD_SERVICE_UUID
//     RX characteristic: WRITE / WRITE_NO_RESPONSE — central -> us
//     TX characteristic: NOTIFY                     — us -> central (needs CCCD)
//
// This plugin only moves bytes and reports connection lifecycle; framing,
// the Noise handshake, and voice encode/decode all happen in JS (see
// src/lib/ble.ts) exactly as they would for a real bitchat-style mesh node.
import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.BluetoothLeAdvertiser
import android.content.Context
import android.os.ParcelUuid
import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import java.util.UUID

private val SERVICE_UUID: UUID = UUID.fromString("7a1b0001-0000-1000-8000-00805f9b34fb")
private val RX_CHARACTERISTIC_UUID: UUID = UUID.fromString("7a1b0002-0000-1000-8000-00805f9b34fb")
private val TX_CHARACTERISTIC_UUID: UUID = UUID.fromString("7a1b0003-0000-1000-8000-00805f9b34fb")
private val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

@SuppressLint("MissingPermission") // guarded by the plugin's declared runtime permissions below
@CapacitorPlugin(
    name = "SamvadBlePeripheral",
    permissions = [
        Permission(strings = [Manifest.permission.BLUETOOTH_ADVERTISE], alias = "advertise"),
        Permission(strings = [Manifest.permission.BLUETOOTH_CONNECT], alias = "connect"),
    ],
)
class SamvadBlePeripheralPlugin : Plugin() {
    private var gattServer: BluetoothGattServer? = null
    private var advertiser: BluetoothLeAdvertiser? = null
    private val connectedDevices = mutableMapOf<String, BluetoothDevice>()
    private lateinit var txCharacteristic: BluetoothGattCharacteristic

    @PluginMethod
    fun initialize(call: PluginCall) {
        if (getPermissionState("advertise") != com.getcapacitor.PermissionState.GRANTED ||
            getPermissionState("connect") != com.getcapacitor.PermissionState.GRANTED
        ) {
            requestAllPermissions(call, "onPermissionsResult")
            return
        }
        resolveInitialize(call)
    }

    @PermissionCallback
    private fun onPermissionsResult(call: PluginCall) {
        resolveInitialize(call)
    }

    private fun resolveInitialize(call: PluginCall) {
        val manager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
        val adapter = manager?.adapter
        // Deliberately NOT gating on isMultipleAdvertisementSupported(): that
        // flag reports support for *concurrent* advertising sets, a stricter
        // capability than the single advertisement we actually need, and
        // it's documented as unreliable on several chipsets (observed false
        // on this device's MediaTek BT stack despite the controller
        // reporting le_number_supported_advertising_sets: 16 at the HCI
        // level). Checking that an advertiser instance exists is what
        // Android itself uses to gate startAdvertising() — if the hardware
        // genuinely can't advertise, that call's onStartFailure() below
        // reports it precisely instead of a blanket "unsupported" here.
        val supported = adapter?.bluetoothLeAdvertiser != null &&
            getPermissionState("advertise") == com.getcapacitor.PermissionState.GRANTED
        val result = JSObject()
        result.put("supported", supported)
        call.resolve(result)
    }

    @PluginMethod
    fun startAdvertising(call: PluginCall) {
        val manager = context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
        val adapter = manager.adapter
        advertiser = adapter.bluetoothLeAdvertiser
        if (advertiser == null) {
            call.reject("BLE advertising unsupported on this device")
            return
        }

        gattServer = manager.openGattServer(context, gattServerCallback)
        val service = BluetoothGattService(SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY)

        val rx = BluetoothGattCharacteristic(
            RX_CHARACTERISTIC_UUID,
            BluetoothGattCharacteristic.PROPERTY_WRITE or BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,
            BluetoothGattCharacteristic.PERMISSION_WRITE,
        )
        txCharacteristic = BluetoothGattCharacteristic(
            TX_CHARACTERISTIC_UUID,
            BluetoothGattCharacteristic.PROPERTY_NOTIFY,
            BluetoothGattCharacteristic.PERMISSION_READ,
        )
        val cccd = BluetoothGattDescriptor(
            CCCD_UUID,
            BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE,
        )
        txCharacteristic.addDescriptor(cccd)

        service.addCharacteristic(rx)
        service.addCharacteristic(txCharacteristic)
        gattServer?.addService(service)

        val settings = AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
            .setConnectable(true)
            .setTimeout(0)
            .build()
        // Deliberately no device name in the payload: a 128-bit service UUID
        // already consumes most of a legacy (31-byte) advertisement.
        val data = AdvertiseData.Builder()
            .setIncludeDeviceName(false)
            .addServiceUuid(ParcelUuid(SERVICE_UUID))
            .build()

        advertiser?.startAdvertising(
            settings,
            data,
            object : AdvertiseCallback() {
                override fun onStartSuccess(settingsInEffect: AdvertiseSettings?) {
                    call.resolve()
                }

                override fun onStartFailure(errorCode: Int) {
                    val reason = when (errorCode) {
                        AdvertiseCallback.ADVERTISE_FAILED_DATA_TOO_LARGE -> "DATA_TOO_LARGE"
                        AdvertiseCallback.ADVERTISE_FAILED_TOO_MANY_ADVERTISERS -> "TOO_MANY_ADVERTISERS"
                        AdvertiseCallback.ADVERTISE_FAILED_ALREADY_STARTED -> "ALREADY_STARTED"
                        AdvertiseCallback.ADVERTISE_FAILED_INTERNAL_ERROR -> "INTERNAL_ERROR"
                        AdvertiseCallback.ADVERTISE_FAILED_FEATURE_UNSUPPORTED -> "FEATURE_UNSUPPORTED"
                        else -> "UNKNOWN"
                    }
                    call.reject("advertise failed: $reason (code=$errorCode)")
                }
            },
        )
    }

    @PluginMethod
    fun stopAdvertising(call: PluginCall) {
        advertiser?.stopAdvertising(object : AdvertiseCallback() {})
        gattServer?.close()
        gattServer = null
        connectedDevices.clear()
        call.resolve()
    }

    @PluginMethod
    fun notify(call: PluginCall) {
        val deviceId = call.getString("deviceId")
        val dataB64 = call.getString("data")
        if (deviceId == null || dataB64 == null) {
            call.reject("deviceId and data are required")
            return
        }
        val device = connectedDevices[deviceId]
        val server = gattServer
        if (device == null || server == null) {
            call.reject("no connected central with deviceId=$deviceId")
            return
        }
        txCharacteristic.value = Base64.decode(dataB64, Base64.NO_WRAP)
        server.notifyCharacteristicChanged(device, txCharacteristic, false)
        call.resolve()
    }

    private val gattServerCallback = object : BluetoothGattServerCallback() {
        override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
            if (newState == android.bluetooth.BluetoothProfile.STATE_CONNECTED) {
                connectedDevices[device.address] = device
                val event = JSObject()
                event.put("deviceId", device.address)
                notifyListeners("centralConnected", event)
            } else if (newState == android.bluetooth.BluetoothProfile.STATE_DISCONNECTED) {
                connectedDevices.remove(device.address)
                val event = JSObject()
                event.put("deviceId", device.address)
                notifyListeners("centralDisconnected", event)
            }
        }

        override fun onCharacteristicWriteRequest(
            device: BluetoothDevice,
            requestId: Int,
            characteristic: BluetoothGattCharacteristic,
            preparedWrite: Boolean,
            responseNeeded: Boolean,
            offset: Int,
            value: ByteArray,
        ) {
            if (characteristic.uuid == RX_CHARACTERISTIC_UUID) {
                val event = JSObject()
                event.put("deviceId", device.address)
                event.put("data", Base64.encodeToString(value, Base64.NO_WRAP))
                notifyListeners("write", event)
            }
            if (responseNeeded) {
                gattServer?.sendResponse(device, requestId, android.bluetooth.BluetoothGatt.GATT_SUCCESS, offset, value)
            }
        }

        override fun onDescriptorWriteRequest(
            device: BluetoothDevice,
            requestId: Int,
            descriptor: BluetoothGattDescriptor,
            preparedWrite: Boolean,
            responseNeeded: Boolean,
            offset: Int,
            value: ByteArray,
        ) {
            if (descriptor.uuid == CCCD_UUID &&
                value.contentEquals(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
            ) {
                val event = JSObject()
                event.put("deviceId", device.address)
                notifyListeners("centralSubscribed", event)
            }
            if (responseNeeded) {
                gattServer?.sendResponse(device, requestId, android.bluetooth.BluetoothGatt.GATT_SUCCESS, offset, value)
            }
        }
    }
}
