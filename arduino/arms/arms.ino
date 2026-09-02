#include <SoftwareSerial.h>
#include <Servo.h>

SoftwareSerial link(2, 3); // RX, TX

Servo servo9;
Servo servo3;

String command;
int angle;

void setup() {
  Serial.begin(9600);
  link.begin(9600);

  servo9.attach(9);
  servo3.attach(5);

  Serial.println("Starting....");

  // Initial positions
  servo9.write(43);
  servo3.write(15);
  delay(1000);

  // Serial.println("Moving shoulders");
  // servo9.write(angle);
  // Serial.println(angle);
  // delay(15);
    

      //   Serial.println("Moving arms");
      //   servo3.write(angle);
      //   Serial.println(angle);
      //   delay(15);
    
      //   servo3.write(angle);
      //   delay(15);

      //   servo9.write(angle);
      //   delay(15);

      // ================ MABUHAY ============================
      // for (int angle = 43; angle <= 140; angle++) {
      //   Serial.println("Moving shoulders");
      //   servo9.write(angle);
      //   Serial.println(angle);
      //   delay(15);
      // }
      // delay(500);

      // for (int angle = 15; angle <= 110; angle++) {
      //   Serial.println("Moving arms");
      //   servo3.write(angle);
      //   Serial.println(angle);
      //   delay(15);
      // }
      // delay(500);

      // for (int angle = 110; angle >= 15; angle--) {
      //   servo3.write(angle);
      //   delay(15);
      // }
      // delay(500);

      // for (int angle = 140; angle >= 43; angle--) {
      //   servo9.write(angle);
      //   delay(15);
      // }

    // ======================= MANO =========================================
    //         for (int angle = 43; angle <= 180; angle++) {
    //     Serial.println("Moving shoulders");
    //     servo9.write(angle);
    //     Serial.println(angle);
    //     delay(15);
    //   }
    //   delay(500);

    //   for (int angle = 15; angle <= 110; angle++) {
    //     Serial.println("Moving arms");
    //     servo3.write(angle);
    //     Serial.println(angle);
    //     delay(15);
    //   }
    //   delay(500);

    //   for (int angle = 110; angle >= 15; angle--) {
    //     servo3.write(angle);
    //     delay(15);
    //   }
    //   delay(500);

    //   for (int angle = 180; angle >= 43; angle--) {
    //     servo9.write(angle);
    //     delay(15);
    //   }
    //   delay(500);
    // }
}

void loop() {

  if (Serial.available() > 0) {
    command = Serial.readStringUntil('\n');
    command.trim();

    // MABUHAY
    if (command == "MABUHAY") {
      for (int angle = 43; angle <= 140; angle++) {
        Serial.println("Moving shoulders");
        servo9.write(angle);
        Serial.println(angle);
        delay(15);
      }
      delay(500);

      for (int angle = 15; angle <= 110; angle++) {
        Serial.println("Moving arms");
        servo3.write(angle);
        Serial.println(angle);
        delay(15);
      }
      delay(500);

      for (int angle = 110; angle >= 15; angle--) {
        servo3.write(angle);
        delay(15);
      }
      delay(500);

      for (int angle = 140; angle >= 43; angle--) {
        servo9.write(angle);
        delay(15);
      }
      delay(500);
    }

    // MANO PO
    if (command == "MANO") {
      for (int angle = 43; angle <= 180; angle++) {
        Serial.println("Moving shoulders");
        servo9.write(angle);
        Serial.println(angle);
        delay(15);
      }
      delay(500);

      for (int angle = 15; angle <= 110; angle++) {
        Serial.println("Moving arms");
        servo3.write(angle);
        Serial.println(angle);
        delay(15);
      }
      delay(500);

      for (int angle = 110; angle >= 15; angle--) {
        servo3.write(angle);
        delay(15);
      }
      delay(500);

      for (int angle = 180; angle >= 43; angle--) {
        servo9.write(angle);
        delay(15);
      }
      delay(500);
    }

    if (command == "TALKING") {

      for (int angle = 43; angle <= 140; angle++) {
        Serial.println("Moving shoulders");
        servo9.write(angle);
        Serial.println(angle);
        delay(15);
      }
      delay(500);

      for (int angle = 15; angle <= 110; angle++) {
        Serial.println("Moving arms");
        servo3.write(angle);
        Serial.println(angle);
        delay(15);
      }
      delay(500);

      for (int angle = 110; angle >= 15; angle--) {
        servo3.write(angle);
        delay(15);
      }
      delay(500);

      for (int angle = 140; angle >= 43; angle--) {
        servo9.write(angle);
        delay(15);
      }
      delay(500);
      
      Serial.println("START_ARM2");
      link.println("START_ARM2");
      delay(5000);

      // while (true) {
      //   if (link.available()) {

      //     String response = link.readStringUntil('\n');
      //     response.trim();

      //     Serial.print("Received: [");
      //     Serial.print(response);
      //     Serial.println("]");

      //     Serial.print("Length = ");
      //     Serial.println(response.length());

      //     if (response == "DONE") {
      //       break;
      //     }
      //   }
      // }
    }
  }
}