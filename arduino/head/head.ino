#include <Servo.h>


Servo servo9;
Servo servo10;


String command;
int angle;


void setup() {
  Serial.begin(9600);


  servo9.attach(9);    // tango
  servo10.attach(10);  // ikot


  Serial.println("Starting...");


  // Initial positions
  servo9.write(90);
  servo10.write(50);


  delay(4000);

  // ----- SERVO10 -----
  // TALKING


  // 50 -> 80
  // for (int angle = 50; angle <= 80; angle++) {
  //   servo10.write(angle);
  //   delay(35);
  // }


  // delay(500);


  // // 80 -> 60
  // for (int angle = 80; angle >= 20; angle--) {
  //   servo10.write(angle);
  //   delay(35);
  // }


  // delay(500);


  // // 60 -> 50
  // for (int angle = 20; angle >= 100; angle--) {
  //   servo10.write(angle);
  //   delay(35);
  // }


  // delay(500);


  // // 50 -> 0
  // for (int angle = 100; angle >= 0; angle--) {
  //   servo10.write(angle);
  //   delay(35);
  // }


  // delay(500);


  // // 0 -> 50 (back to initial)
  // for (int angle = 0; angle <= 50; angle++) {
  //   servo10.write(angle);
  //   delay(35);
  // }


  // delay(1000);


  // ----- SERVO9 -----
  // MANO PO


  // 80 -> 0
  // for (int angle = 90; angle >= 10; angle--) {
  //   servo9.write(angle);
  //   delay(35);
  // }


  // delay(500);


  // // 0 -> 80 (back to initial)
  // for (int angle = 10; angle <= 90; angle++) {
  //   servo9.write(angle);
  //   delay(35);
  // }
}


void loop() {


  if (Serial.available() > 0) {
    command = Serial.readStringUntil('\n');
    command.trim();


    if (command == "MANO") {
      for (int angle = 90; angle >= 10; angle--) {
        servo9.write(angle);
        delay(35);
      }


      delay(2500);


      // 0 -> 80 (back to initial)
      for (int angle = 10; angle <= 90; angle++) {
        servo9.write(angle);
        delay(35);
      }
    }


    if (command == "TALKING") {
      for (int angle = 50; angle <= 80; angle++) {
        servo10.write(angle);
        delay(35);
        Serial.println("Moving...");
      }


      delay(1000);

      Serial.println("Next...");
      // 80 -> 60
      for (int angle = 80; angle >= 60; angle--) {
        servo10.write(angle);
        delay(35);
        Serial.println(angle);
      }


      delay(1000);


      // 60 -> 50
      for (int angle = 60; angle >= 50; angle--) {
        servo10.write(angle);
        delay(35);
      }


      delay(1000);


      // 50 -> 0
      for (int angle = 50; angle >= 0; angle--) {
        servo10.write(angle);
        delay(35);
      }


      delay(1000);


      // 0 -> 50 (back to initial)
      for (int angle = 0; angle <= 50; angle++) {
        servo10.write(angle);
        delay(35);
      }


      delay(1000);
    }
  }
}

