package ru.kabinet.writer;

import android.view.InputDevice;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Сообщает окну, подключена ли физическая клавиатура (Bluetooth, USB, док планшета). */
@CapacitorPlugin(name = "HwKeyboard")
public class HwKeyboardPlugin extends Plugin {

    @PluginMethod
    public void status(PluginCall call) {
        JSObject res = new JSObject();
        res.put("connected", isConnected());
        call.resolve(res);
    }

    private boolean isConnected() {
        for (int id : InputDevice.getDeviceIds()) {
            InputDevice d = InputDevice.getDevice(id);
            if (d == null || d.isVirtual()) continue;
            boolean keyboardSource = (d.getSources() & InputDevice.SOURCE_KEYBOARD) == InputDevice.SOURCE_KEYBOARD;
            if (keyboardSource && d.getKeyboardType() == InputDevice.KEYBOARD_TYPE_ALPHABETIC) return true;
        }
        return false;
    }
}
