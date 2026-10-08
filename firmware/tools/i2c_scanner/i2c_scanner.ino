// Diagnostic-only sketch: NOT part of the main firmware.
// Scans common ESP8266 dev-board GPIO pin pairs for any responding I2C
// device, so we can find which pins the OLED's fixed socket is actually
// wired to (and its address) without needing the board's documentation.
//
// Flash this with Arduino IDE, then open Serial Monitor at 115200 baud.
// It will print one line per (pin pair, address) that gets a response.

#include <Wire.h>

struct PinPair {
  const char* label;
  int sda;
  int scl;
};

// Common ESP8266 dev-board GPIO assignments (NodeMCU "D" labels in comments).
PinPair candidates[] = {
  {"SDA=GPIO4(D2)  SCL=GPIO5(D1)", 4, 5},
  {"SDA=GPIO5(D1)  SCL=GPIO4(D2)", 5, 4},
  {"SDA=GPIO0(D3)  SCL=GPIO2(D4)", 0, 2},
  {"SDA=GPIO2(D4)  SCL=GPIO0(D3)", 2, 0},
  {"SDA=GPIO12(D6) SCL=GPIO14(D5)", 12, 14},
  {"SDA=GPIO14(D5) SCL=GPIO12(D6)", 14, 12},
  {"SDA=GPIO13(D7) SCL=GPIO15(D8)", 13, 15},
  {"SDA=GPIO15(D8) SCL=GPIO13(D7)", 15, 13},
  {"SDA=GPIO2(D4)  SCL=GPIO14(D5)", 2, 14},
  {"SDA=GPIO14(D5) SCL=GPIO2(D4)", 14, 2},
};

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println();
  Serial.println("I2C scan starting...");

  bool foundAny = false;

  for (size_t i = 0; i < sizeof(candidates) / sizeof(candidates[0]); i++) {
    PinPair& p = candidates[i];
    Serial.print("Trying pins: ");
    Serial.println(p.label);
    Serial.flush();

    Wire.begin(p.sda, p.scl);
    delay(50);

    for (byte addr = 1; addr < 127; addr++) {
      Serial.print("  addr 0x");
      if (addr < 16) Serial.print("0");
      Serial.print(addr, HEX);
      Serial.print("...");
      Serial.flush();

      Wire.beginTransmission(addr);
      byte err = Wire.endTransmission();

      if (err == 0) {
        foundAny = true;
        Serial.print(" FOUND (");
        Serial.print(p.label);
        Serial.println(")");
      } else {
        Serial.println(" no");
      }
      yield();  // let the WiFi/WDT housekeeping run so a stuck bus doesn't silently reboot us
    }
    Serial.println("  (pin pair done)");
    Serial.flush();
  }

  if (!foundAny) {
    Serial.println("No I2C device responded on any candidate pin pair.");
    Serial.println("Check power (VCC/GND) to the OLED socket.");
  }
  Serial.println("I2C scan done.");
}

void loop() {
}
