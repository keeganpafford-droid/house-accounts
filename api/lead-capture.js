export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  try {
    const lead = req.body;

    await fetch("https://script.google.com/macros/s/AKfycbxXCrl1kUVFOmprMdrBenyLI2j9pWnef4UmvMvRFtH7ufov_ovHIiV2ZDHn0Iy-XCkU/exec", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(lead)
    });

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Lead capture error:", error);
    return res.status(500).json({ success: false, error: "Lead capture failed" });
  }
}
