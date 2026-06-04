# -*- coding: utf-8 -*-
"""Prueba de envío por Gmail. Manda un correo de prueba REAL al remitente
(o a la dirección que pases como argumento) para validar la App Password.

Uso (desde backend/):
    py scripts/test_email.py                 # se lo manda a gmail_sender
    py scripts/test_email.py otro@correo.com # a otra dirección
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.core import mailer  # noqa: E402

settings = mailer.load_settings()
to = sys.argv[1] if len(sys.argv) > 1 else None
print(f"Remitente: {settings.sender or '(vacío)'}")
print(f"Enviando prueba a: {to or settings.sender or '(vacío)'} ...")
res = mailer.send_test(settings, to)
if res["ok"]:
    print("OK ✅  Revisá tu bandeja de entrada.")
else:
    print("ERROR ❌ ", res["error"])
