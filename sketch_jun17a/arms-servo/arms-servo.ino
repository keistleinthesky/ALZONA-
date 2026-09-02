#include <Servo.h>

Servo servo9;
Servo servo3;

String command;
int angle;

void setup() {
  Serial.begin(9600);

  servo9.attach(9);
  servo3.attach(3);

  // Initial positions
  servo9.write(43);
  servo3.write(10);
}

void loop() {

  if (Serial.available() > 0) {
    command = Serial.readStringUntil('\n');
    command.trim();

    // ======================
    // MABUHAY COMMAND
    // ======================
    if (command == "MABUHAY") {

      // Servo 9: 43° -> 140°
      for (angle = 43; angle <= 140; angle++) {
        servo9.write(angle);
        delay(15);
      }

      delay(500);

      // Servo 3: 15° -> 130°
      for (angle = 15; angle <= 130; angle++) {
        servo3.write(angle);
        delay(15);
      }

      delay(1000);

      // Servo 3 returns
      for (angle = 130; angle >= 15; angle--) {
        servo3.write(angle);
        delay(15);
      }

      delay(1000);

      // Servo 9 returns
      for (angle = 140; angle >= 43; angle--) {
        servo9.write(angle);
        delay(15);
      }

      delay(1000);
    }

    // ======================
    // MANO COMMAND
    // ======================
    else if (command == "MANO") {

      // Servo 9: 43° -> 180°
      for (angle = 43; angle <= 180; angle++) {
        servo9.write(angle);
        delay(15);
      }

      delay(500);

      // Servo 3: 15° -> 130°
      for (angle = 15; angle <= 130; angle++) {
        servo3.write(angle);
        delay(15);
      }

      delay(1000);

      // Servo 9 returns: 180° -> 43°
      for (angle = 180; angle >= 43; angle--) {
        servo9.write(angle);
        delay(15);
      }

      delay(1000);
    }
  }
}