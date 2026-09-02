import serial
import time

# Change COM3 to your Arduino port
arduino = serial.Serial('COM3', 9600, timeout=1)

# Wait for Arduino to initialize
time.sleep(2)

while True:
    command = input("Enter command (MABUHAY, MANO, EXIT): ").strip().upper()

    if command == "EXIT":
        break

    if command in ["MABUHAY", "MANO"]:
        arduino.write((command + "\n").encode())
        print(f"Sent: {command}")
    else:
        print("Invalid command")

arduino.close()