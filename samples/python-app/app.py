import os
from flask import Flask, jsonify

app = Flask(__name__)
port = int(os.environ.get("PORT", 5000))

@app.route("/")
def home():
    return "Hello from Pushr Python App!"

@app.route("/health")
def health():
    return jsonify({"status": "ok", "app": "python-app"}), 200

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=port)
