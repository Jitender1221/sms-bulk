<?php
header("Content-Type: application/json");

// Database connection
$conn = new mysqli("localhost", "root", "", "login_system");

if ($conn->connect_error) {
    die(json_encode(["error" => "Database connection failed: " . $conn->connect_error]));
}

// Read input
$data = json_decode(file_get_contents("php://input"), true);
$action = $data["action"] ?? '';
$rawPhones = $data["phone"] ?? '';

if (!$rawPhones) {
    echo json_encode(["success" => false, "message" => "Phone number(s) required"]);
    exit;
}

// Normalize and split phone numbers
$phones = preg_split('/[\s,]+/', trim($rawPhones));
$phones = array_filter(array_map('trim', $phones));

if (empty($phones)) {
    echo json_encode(["success" => false, "message" => "Invalid phone numbers"]);
    exit;
}

if ($action == "send_message") {
    $msg = $data["message"] ?? '';
    if (!$msg) {
        echo json_encode(["success" => false, "message" => "Message is required"]);
        exit;
    }

    $results = [];

    foreach ($phones as $phone) {
        // Save or update message in DB
        $stmt = $conn->prepare("INSERT INTO users (phone, message) 
                                VALUES (?, ?) 
                                ON DUPLICATE KEY UPDATE message = ?");
        if (!$stmt) {
            $results[] = ["phone" => $phone, "status" => "failed", "error" => "SQL error: " . $conn->error];
            continue;
        }

        $stmt->bind_param("sss", $phone, $msg, $msg);
        if (!$stmt->execute()) {
            $results[] = ["phone" => $phone, "status" => "failed", "error" => "DB error: " . $stmt->error];
            $stmt->close();
            continue;
        }
        $stmt->close();

        // Build payload
        $payload = [
            "phone" => $phone,
            "message" => $msg
        ];

        if (isset($data["media"])) {
            $media = $data["media"];
            $payload["media"] = [
                "type" => $media["type"],
                "url" => $media["url"],
                "caption" => $msg
            ];
        }

        // Send to Node.js
        $ch = curl_init("http://localhost:3000/send-message");
        curl_setopt($ch, CURLOPT_POST, 1);
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($payload));
        curl_setopt($ch, CURLOPT_HTTPHEADER, ["Content-Type: application/json"]);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);

        $response = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        $decoded = json_decode($response, true);
        if ($httpCode == 200 && isset($decoded['success']) && $decoded['success']) {
            $results[] = ["phone" => $phone, "status" => "success"];
        } else {
            $results[] = ["phone" => $phone, "status" => "failed", "error" => $decoded['error'] ?? 'Unknown error'];
        }
    }

    echo json_encode(["success" => true, "results" => $results]);
    exit;
}

echo json_encode(["success" => false, "message" => "Invalid request"]);
$conn->close();