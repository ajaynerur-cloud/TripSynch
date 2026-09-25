# TripSynch V7
Render serves frontend and API. GitHub JSON stores users, password hashes, trips, expenses and settlements. Set Render environment variables from render.yaml. V7 adds signup, login, logout, account-based trip membership, invite login/join, owner settle-and-remove, owner remove for zero-balance members, and a non-dialog invite overlay with reliable close controls.

Security: passwords are salted and hashed with Node scrypt; they are never stored as plaintext. Set a strong APP_SECRET in Render. This JSON design is suitable for personal/light use, not high-scale identity workloads.
