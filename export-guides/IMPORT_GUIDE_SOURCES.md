# Prospect Import Guide Research Sources

These references were reviewed once while writing the static House Accounts import guides. The application does not fetch them at runtime.

- Salesforce Help — Export Reports: https://help.salesforce.com/s/articleView?id=analytics.reports_export.htm&type=5
- HubSpot Knowledge Base — Export your records: https://knowledge.hubspot.com/import-and-export/export-records
- Pipedrive Knowledge Base — Exporting data from Pipedrive: https://support.pipedrive.com/en/article/exporting-data-from-pipedrive
- Apollo Knowledge Base — CSV export documentation and in-product export guidance. Wording in the House Accounts guide is intentionally cautious because availability varies by plan, credits, record type, and permissions.
- ZoomInfo Help Center — company/contact list export guidance. Wording in the House Accounts guide is intentionally cautious because availability varies by subscription, credits, and administrator permissions.

## Product requirement verified in code

The current Prospect Intelligence uploader accepts `.csv` files only and requires a recognizable Company Name column. Website, industry, location, and contact fields are optional.
