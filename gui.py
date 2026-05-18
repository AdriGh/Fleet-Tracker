"""Interfaz de escritorio para el generador de informes DVIR."""

import os
import sys
import traceback
from datetime import datetime

import tkinter as tk
from tkinter import filedialog, messagebox, ttk

import dvir_report

APP_DIR = os.path.dirname(os.path.abspath(__file__))
DOWNLOADS = os.path.join(os.path.expanduser("~"), "Downloads")
DEFAULT_ROSTER = os.path.join(APP_DIR, "roster.csv")


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Generador de Informe DVIR")
        self.geometry("680x520")
        self.resizable(False, False)
        self.configure(padx=18, pady=14)

        self.dvir_path = tk.StringVar()
        self.activity_path = tk.StringVar()
        self.roster_path = tk.StringVar(
            value=DEFAULT_ROSTER if os.path.exists(DEFAULT_ROSTER) else ""
        )
        self.company = tk.StringVar(value="CHASER")
        self.date_label = tk.StringVar(value=self._guess_date())
        self.min_miles = tk.StringVar(value="25")
        self.out_dir = tk.StringVar(value=DOWNLOADS)

        self._build()

    @staticmethod
    def _guess_date():
        now = datetime.now()
        return f"{now.month}.{now.day}"

    def _build(self):
        title = tk.Label(self, text="Generador de Informe DVIR diario",
                         font=("Segoe UI", 14, "bold"))
        title.pack(anchor="w")
        tk.Label(self, text="Cruza el CSV de DVIR con la actividad de "
                            "vehiculos y produce el Excel del dia.",
                 fg="#555").pack(anchor="w", pady=(0, 10))

        grid = tk.Frame(self)
        grid.pack(fill="x")
        r = 0

        self._file_row(grid, r, "CSV de DVIR:", self.dvir_path,
                       self._pick_dvir); r += 1
        self._file_row(grid, r, "CSV de actividad:", self.activity_path,
                       self._pick_activity); r += 1
        self._file_row(grid, r, "CSV de roster:", self.roster_path,
                       self._pick_roster); r += 1

        tk.Label(grid, text="Empresa:").grid(row=r, column=0, sticky="w",
                                             pady=4)
        tk.Entry(grid, textvariable=self.company, width=24).grid(
            row=r, column=1, sticky="w")
        r += 1

        tk.Label(grid, text="Etiqueta del dia:").grid(row=r, column=0,
                                                      sticky="w", pady=4)
        de = tk.Frame(grid); de.grid(row=r, column=1, sticky="w")
        tk.Entry(de, textvariable=self.date_label, width=12).pack(side="left")
        tk.Label(de, text="  (mes.dia, ej. 5.18)", fg="#888").pack(side="left")
        r += 1

        tk.Label(grid, text="Millas min. activo:").grid(row=r, column=0,
                                                        sticky="w", pady=4)
        me = tk.Frame(grid); me.grid(row=r, column=1, sticky="w")
        tk.Spinbox(me, textvariable=self.min_miles, from_=0, to=10000,
                   width=8).pack(side="left")
        tk.Label(me, text="  un camion con mas millas y sin DVIR = NO DVIR",
                 fg="#888").pack(side="left")
        r += 1

        self._file_row(grid, r, "Carpeta de salida:", self.out_dir,
                       self._pick_outdir, is_dir=True); r += 1

        grid.columnconfigure(1, weight=1)

        btn = tk.Button(self, text="Generar informe", command=self._generate,
                        bg="#1F4E79", fg="white",
                        font=("Segoe UI", 11, "bold"), padx=16, pady=8,
                        activebackground="#163a5c", activeforeground="white",
                        cursor="hand2")
        btn.pack(pady=14)

        tk.Label(self, text="Registro:", font=("Segoe UI", 9, "bold")).pack(
            anchor="w")
        self.log = tk.Text(self, height=8, width=80, state="disabled",
                           bg="#f4f4f4", relief="flat", font=("Consolas", 9))
        self.log.pack(fill="both", expand=True, pady=(2, 0))

    def _file_row(self, parent, row, label, var, command, is_dir=False):
        tk.Label(parent, text=label).grid(row=row, column=0, sticky="w",
                                          pady=4)
        frame = tk.Frame(parent)
        frame.grid(row=row, column=1, sticky="we")
        tk.Entry(frame, textvariable=var).pack(side="left", fill="x",
                                               expand=True)
        tk.Button(frame, text="Examinar...", command=command).pack(
            side="left", padx=(6, 0))

    def _pick_csv(self, var, title):
        path = filedialog.askopenfilename(
            title=title, initialdir=DOWNLOADS,
            filetypes=[("CSV", "*.csv"), ("Todos", "*.*")])
        if path:
            var.set(path)

    def _pick_dvir(self):
        self._pick_csv(self.dvir_path, "Selecciona el CSV de DVIR")

    def _pick_activity(self):
        self._pick_csv(self.activity_path,
                       "Selecciona el CSV de actividad")

    def _pick_roster(self):
        self._pick_csv(self.roster_path, "Selecciona el CSV de roster")

    def _pick_outdir(self):
        path = filedialog.askdirectory(title="Carpeta de salida",
                                       initialdir=self.out_dir.get())
        if path:
            self.out_dir.set(path)

    def _write_log(self, text):
        self.log.configure(state="normal")
        self.log.insert("end", text + "\n")
        self.log.see("end")
        self.log.configure(state="disabled")
        self.update_idletasks()

    def _generate(self):
        self.log.configure(state="normal")
        self.log.delete("1.0", "end")
        self.log.configure(state="disabled")

        dvir = self.dvir_path.get().strip()
        activity = self.activity_path.get().strip()
        roster = self.roster_path.get().strip()
        company = self.company.get().strip() or "CHASER"
        date_label = self.date_label.get().strip()

        if not dvir or not os.path.exists(dvir):
            messagebox.showerror("Falta archivo",
                                 "Selecciona un CSV de DVIR valido.")
            return
        if not activity or not os.path.exists(activity):
            messagebox.showerror("Falta archivo",
                                 "Selecciona un CSV de actividad valido.")
            return
        if not date_label:
            messagebox.showerror("Falta dato",
                                 "Indica la etiqueta del dia (ej. 5.18).")
            return
        try:
            min_miles = float(self.min_miles.get())
        except ValueError:
            messagebox.showerror("Dato invalido",
                                 "Millas minimas debe ser un numero.")
            return

        safe_label = date_label.replace(".", "-").replace("/", "-")
        out_name = f"DVIR {company} {safe_label}.xlsx"
        out_path = os.path.join(self.out_dir.get().strip() or DOWNLOADS,
                                out_name)

        try:
            self._write_log(f"Leyendo DVIR:     {os.path.basename(dvir)}")
            self._write_log(f"Leyendo actividad: {os.path.basename(activity)}")
            self._write_log(
                f"Roster:           {os.path.basename(roster) or '(sin roster)'}")
            result = dvir_report.generate(
                dvir, activity, roster, company, date_label,
                min_miles, out_path)
            self._write_log("")
            self._write_log(f"Conductores en el bloque: {result['groups']}")
            self._write_log(f"Filas totales:            {result['rows']}")
            self._write_log(f"Filas NO DVIR detectadas: {result['nodvir']}")
            self._write_log("")
            self._write_log(f"Guardado en: {result['out']}")
            if messagebox.askyesno(
                    "Listo",
                    f"Informe generado:\n{out_path}\n\n¿Abrir el archivo?"):
                os.startfile(out_path)
        except Exception as exc:
            self._write_log("")
            self._write_log("ERROR: " + str(exc))
            self._write_log(traceback.format_exc())
            messagebox.showerror("Error al generar", str(exc))


def main():
    App().mainloop()


if __name__ == "__main__":
    main()
