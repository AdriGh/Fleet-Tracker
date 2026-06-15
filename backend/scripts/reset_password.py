"""Resetea la contrasena de un usuario local (recuperacion de acceso).

Las contrasenas se guardan hasheadas (no se pueden leer), asi que cuando uno
se olvida la clave, la unica via es resetearla. Este script lo hace usando el
mismo hashing de la app, directo sobre la base local.

Uso (desde la carpeta backend/):
    py scripts/reset_password.py                 # interactivo
    py scripts/reset_password.py <usuario> <clave>

Sin argumentos lista los usuarios y pregunta cual resetear y la clave nueva.
"""

import getpass
import os
import sys

# Permite ejecutarlo como 'py scripts/reset_password.py' desde backend/.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import select          # noqa: E402

from app.core.auth import hash_password   # noqa: E402
from app.db import SessionLocal, User     # noqa: E402


def main() -> None:
    args = sys.argv[1:]
    with SessionLocal() as session:
        users = list(session.scalars(select(User).order_by(User.id)))
        if not users:
            print("No hay usuarios en la base.")
            return
        print("Usuarios:")
        for u in users:
            print(f"  - {u.username}  ({u.role})")

        username = (args[0] if len(args) >= 1
                    else input("\nUsuario a resetear: ")).strip().lower()
        user = session.scalars(
            select(User).where(User.username == username)).first()
        if user is None:
            print(f"\nNo existe el usuario '{username}'.")
            return

        pw = (args[1] if len(args) >= 2
              else getpass.getpass("Nueva clave (min 8 caracteres): "))
        if len(pw) < 8:
            print("La clave debe tener al menos 8 caracteres.")
            return

        user.pw_hash = hash_password(pw)
        session.commit()
        print(f"\nListo. Clave reseteada para '{user.username}'. "
              "Ya podes entrar con la nueva.")


if __name__ == "__main__":
    main()
