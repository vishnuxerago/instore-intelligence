#include <Arduino.h>
#include "esp_camera.h"
#include <WiFi.h>
#include "board_config.h"

const char *ssid = "deena";
const char *password = "12345678";

void startCameraServer();
void setupLedFlash();

void setup() {
  Serial.begin(115200);
  Serial.setDebugOutput(true);
  Serial.println();

  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;
  config.pin_sccb_sda = SIOD_GPIO_NUM;
  config.pin_sccb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;

  // ✅ Lower clock reduces heat/instability on AI Thinker
  config.xclk_freq_hz = 10000000;  // 10MHz instead of 20MHz

  // ✅ Use GRAYSCALE — ArUco only needs luminance, saves bandwidth
  config.pixel_format = PIXFORMAT_GRAYSCALE;

  // ✅ QVGA is plenty for ArUco and won't hang the stream
  config.frame_size = FRAMESIZE_QVGA;  // 320x240

  // ✅ GRAB_LATEST prevents stale frame buildup
  config.grab_mode = CAMERA_GRAB_LATEST;
  config.fb_location = CAMERA_FB_IN_DRAM;
  config.jpeg_quality = 12;

  // ✅ 2 buffers lets capture and processing run without blocking
  config.fb_count = 2;

  if (psramFound()) {
    Serial.println("PSRAM found — using PSRAM for framebuffer");
    config.fb_location = CAMERA_FB_IN_PSRAM;
    config.fb_count = 2;
  }

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("Camera init failed: 0x%x\n", err);
    return;
  }

  sensor_t *s = esp_camera_sensor_get();
  if (s->id.PID == OV3660_PID) {
    s->set_vflip(s, 1);
    s->set_brightness(s, 1);
    s->set_saturation(s, -2);
  }

  // ✅ Lock frame size — don't let web UI upscale it
  s->set_framesize(s, FRAMESIZE_QVGA);

  // ✅ Increase contrast helps ArUco marker detection
  s->set_contrast(s, 2);
  s->set_sharpness(s, 2);

#if defined(LED_GPIO_NUM)
  setupLedFlash();
#endif

  WiFi.begin(ssid, password);
  WiFi.setSleep(false);

  Serial.print("Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nWiFi connected");

  startCameraServer();

  Serial.print("Camera Ready! http://");
  Serial.println(WiFi.localIP());
}

void loop() {
  delay(10000);
}
