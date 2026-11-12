# Railway IaC safety

The Railway project configuration is .railway/railway.ts.
- npm install --prefix .railway
- railway config plan is read-only and should show one service and one volume.
- railway config apply creates real resources and is NOT authorized by CI.
- MCP_SETUP_SECRET must be unique and set by the new project owner.
- Never connect or import production Docker/VPS database files.
