<!DOCTYPE html>
<html lang="en">

<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>WhatsApp Bulk Sender</title>
    <style>
    body {
        font-family: Arial;
        max-width: 700px;
        margin: 30px auto;
        padding: 20px;
        background: #f8f8f8;
        border-radius: 8px;
        box-shadow: 0 0 10px rgba(0, 0, 0, 0.1);
    }

    input,
    textarea {
        width: 100%;
        margin-bottom: 15px;
        padding: 10px;
        border-radius: 5px;
        border: 1px solid #ccc;
        box-sizing: border-box;
    }

    button {
        padding: 10px 20px;
        background: #25D366;
        color: white;
        border: none;
        border-radius: 5px;
        cursor: pointer;
        margin-right: 10px;
    }

    button:hover {
        background: #1da851;
    }

    #status {
        background: #fff;
        border: 1px solid #ccc;
        padding: 10px;
        min-height: 150px;
        border-radius: 5px;
        white-space: pre-wrap;
        overflow-y: auto;
    }
    </style>
</head>

<body>

    <h2>Bulk WhatsApp Sender via Excel</h2>

    <label>Upload Excel File (.xlsx):</label>
    <input type="file" id="excelFile" accept=".xlsx,.xls" /><br />

    <label>Type your message (use #StudentName#, #AIR#, #CollegeName# placeholders):</label>
    <textarea id="messageInput" rows="6" placeholder="Type your message here..."></textarea><br />

    <label>Delay between messages (seconds):</label>
    <input type="number" id="delay" value="3" min="1" /><br />

    <button onclick="sendBulkExcel()">Send Messages</button>
    <button onclick="downloadLog()">Download Log</button>

    <div id="status"></div>

    <script src="https://cdn.jsdelivr.net/npm/xlsx/dist/xlsx.full.min.js"></script>
    <script>
    async function sendBulkExcel() {
        const file = document.getElementById('excelFile').files[0];
        const delaySec = parseInt(document.getElementById('delay').value);
        const rawMessage = document.getElementById('messageInput').value.trim();
        const statusDiv = document.getElementById('status');
        statusDiv.textContent = "";

        if (!file) {
            alert("Please select an Excel file");
            return;
        }
        if (!rawMessage) {
            alert("Please type your message");
            return;
        }

        try {
            const data = await file.arrayBuffer();
            const workbook = XLSX.read(data);
            const sheetName = workbook.SheetNames[0];
            const sheet = workbook.Sheets[sheetName];
            const rows = XLSX.utils.sheet_to_json(sheet);

            if (rows.length === 0) {
                alert("Excel file is empty!");
                return;
            }

            statusDiv.textContent += `Found ${rows.length} rows.\n`;

            for (let row of rows) {
                // Handle multiple possible phone column names
                let phone = row.Phone || row.phone || row.Mobile || row.mobile || "";
                phone = phone.toString().replace(/\D/g, ""); // remove non-digit chars
                if (!phone) {
                    statusDiv.textContent += "❌ Missing phone number. Skipping row.\n";
                    continue;
                }
                if (!phone.startsWith("91")) phone = "91" + phone;

                const message = rawMessage
                    .replace(/#StudentName#/g, row.StudentName || "")
                    .replace(/#AIR#/g, row.AIR || "")
                    .replace(/#CollegeName#/g, row.CollegeName || "");

                try {
                    const res = await fetch("http://localhost:3000/send-message", {
                        method: 'POST',
                        headers: {
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify({
                            phone,
                            message
                        })
                    });
                    const data = await res.json();
                    statusDiv.textContent += `${phone}: ${data.success ? '✅ Sent' : '❌ Failed'}\n`;
                } catch (e) {
                    statusDiv.textContent += `${phone}: ❌ Error\n`;
                }

                statusDiv.scrollTop = statusDiv.scrollHeight;
                await new Promise(r => setTimeout(r, delaySec * 1000));
            }

            statusDiv.textContent += "\n✅ All messages processed.";
        } catch (err) {
            alert("Error reading Excel file: " + err.message);
        }
    }

    function downloadLog() {
        window.open("http://localhost:3000/download-log", "_blank");
    }
    </script>

</body>

</html>