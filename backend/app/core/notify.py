"""Orquesta el aviso de NO DVIR: infractores + contacto + CC + correo.

Toma los grupos de un bloque diario (de `sheet_report.parse_blocks`) y el
`ContactBook` (de `contacts.parse_contacts`), y produce:
    - notices: avisos listos para enviar (con email del conductor y CC).
    - review:  conductores infractores sin contacto/region que hay que revisar.
"""

import html as _html
from dataclasses import dataclass, field

from .cc_routing import cc_for_region, region_from_truck
from .contacts import ContactBook
from .engine import MIN_DURATION_SECONDS
from .sheet_report import Group, offender_reasons


@dataclass
class Notice:
    driver: str
    company: str
    region: str | None
    email: str
    cc: list[str]
    reasons: list[dict]
    review_reason: str = ""  # no vacio => va a la lista de revisar
    units: list[str] = field(default_factory=list)
    phone: str = ""          # telefono del contacto (para SMS)


def _summarize_units(reasons: list[dict]) -> list[str]:
    """Texto por motivo infractor, p. ej. 'CF2254: NO DVIR',
    'Pre-trip: no registrado' o 'Pre-trip: 7m 52s (< 15 min)'."""
    out = []
    for r in reasons:
        if r["type"] == "NO_DVIR":
            out.append(f"{r['unit']}: NO DVIR")
        elif r["type"] == "MISSING":
            out.append(f"{r['inspection']}: no registrado")
        else:  # SHORT
            out.append(f"{r['inspection']}: {r['detail']} (< 15 min)")
    return out


def build_notices(groups: list[Group], book: ContactBook,
                  threshold: int = MIN_DURATION_SECONDS
                  ) -> tuple[list[Notice], list[Notice]]:
    """Devuelve (notices, review) para un bloque diario."""
    notices: list[Notice] = []
    review: list[Notice] = []

    for g in groups:
        reasons = offender_reasons(g, threshold)
        if not reasons:
            continue
        # Unidad sin conductor en el reporte (p. ej. MDW-CF1846): no hay a
        # quien avisar y suelen ser unidades no asignadas/en desuso. Se omite.
        if not g.driver:
            continue

        contact = book.match(g.driver)
        unit = g.primary_unit()
        # Region: la del contacto (por su Truck#); si no, se deduce de la
        # unidad del propio bloque como respaldo.
        if contact and contact.region:
            region = contact.region
        else:
            region = region_from_truck(unit)
        # Contradiccion: un conductor de MCC cuya unidad no tiene prefijo de
        # terminal cae como "CHASER" en el respaldo. No se rutea mal: se manda
        # a revisar para que se cargue su terminal (Truck# con prefijo).
        if (contact and contact.company.upper() == "MCC"
                and region == "CHASER"):
            region = None
        cc = cc_for_region(region)

        notice = Notice(
            driver=g.driver or "(sin nombre)",
            company=g.company,
            region=region,
            email=contact.email if contact else "",
            cc=cc,
            reasons=reasons,
            units=_summarize_units(reasons),
            phone=contact.phone if contact else "",
        )

        # Acumula todos los problemas que impiden enviar (no solo el primero).
        problems: list[str] = []
        if contact is None:
            problems.append("no está en 'Driver info'")
        else:
            if not contact.email:
                problems.append("sin email en 'Driver info'")
            if not cc:
                problems.append(
                    f"terminal no reconocida (unidad {unit or '—'}; "
                    "cargar el prefijo regional, p. ej. ATL-CI2033)")

        if problems:
            notice.review_reason = "; ".join(problems)
            review.append(notice)
        else:
            notices.append(notice)

    return notices, review


# --- Composicion del correo --------------------------------------------------
DEFAULT_SUBJECT = "DVIR Compliance Notice — {date}"

# Parrafo que debe ir en negrita en la version HTML del correo. Debe coincidir
# EXACTAMENTE (incluido el apostrofo de "DVIR's") con la linea en DEFAULT_BODY.
BOLD_PARAGRAPH = (
    "If you have any questions, comments, thoughts, or issues with regards to "
    "Samsara, HOS, logs, or DVIR's, please reach out to Ryan Andrews at "
    "773-765-8798."
)

# Texto oficial del aviso (provisto por Safety/Maintenance). SIN placeholders.
# Lo comparten el email y el SMS (el email le agrega saludo, issues y firma).
NOTICE_BODY = """Performing a Pre and Post-trip inspection is a requirement of the DOT and must be done for each and every shift.  As a company, we require a DVIR to be completed and submitted through the app as well.  We do this as a means of having proof that a proper Pre- and Post-trip inspection was performed.  If pulled over, an officer can immediately place you out of service for not having a Pre-trip inspection completed.  Further, all information entered into Samsara is available to all insurance providers.  When they see a driver habitually not doing the correct things that they are supposed to be doing, it results in a higher premium and could potentially lead to a driver being disqualified from working for us.  We do not wish for something so simple to become such a problem.  A proper 15 minute inspection sets you up for a successful day.  It reduces the chance of a breakdown or need for road service by an incredible 87%!!!!  This saves your time and the company's money.

This is the correct process for starting your shift and having a Pre-trip and DVIR submitted properly:

1........Open your Samsara app and certify any previous day's logs that have not been certified.  (ALL LOGS SHOULD BE CERTIFIED AT END OF SHIFT)
2........Assign yourself to the truck you will be driving for the day.
3.........Put yourself in "On Duty" status and enter the remark "Pre-Trip Inspection" (This is a prompted remark so you do not even need to type it, just select it)
4.........Create a DVIR and select vehicle if bobtail and vehicle + tailer if already hooked to your box/chassis.  Vehicle and location info should automatically populate.
5.........Choose Pre or post trip accordingly.
6........Take and submit your walkaround photos.
7.........Go through the list of vehicle defects.  Anything that needs correction or to be fixed should be noted. (A PROPER PRETRIP SHOULD LAST 15 MINS)
8..........If all is safe and legal, mark as "Safe to Drive".....if not, "Unsafe"....and click next.
9..........Certify and submit
10.......add BOL or Load # as your shipping ID

You should receive a message that all tasks have been completed and you can go about your day.

When a driver receives a violation(s) on an inspection, this greatly affects the company's Safety scores.  The chain reaction leads, again, to higher insurance premiums, difficulty securing new customers/lanes of work, and, once a certain threshold is reached, EVERY TIME an officer sees one of our trucks they will pull you over which leads to more wasted time.   A driver can leave a company at any time, yet their violations will remain for 2 years.  We, as a company, need to protect our scores.  We cannot and will not allow driver's negligence to regulations, policies and procedures to jeopardize the company and the bottom line.

We are monitoring these items closely internally and any deviation from the process will have consequences including immediate termination for egregious violations.

As an  example.....If you submit a DVIR stating all equipment is safe and you are then pulled over and placed out of service for a bald tire.....this would have been something caught during a Pre-trip and will not be tolerated.  IF THERE IS SOMETHING WRONG WITH THE EQUIPMENT, REPORT IT SO WE CAN FIX IT!!!!

If you have any questions, comments, thoughts, or issues with regards to Samsara, HOS, logs, or DVIR's, please reach out to Ryan Andrews at 773-765-8798.

Your time and cooperation in this matter is greatly appreciated......DRIVE SAFE!!!!!"""

# Versión COMPACTA para SMS: mantiene los 10 pasos completos pero recorta la
# prosa explicativa (para bajar la cantidad de segmentos del SMS).
SMS_NOTICE_BODY = """A Pre- and Post-trip inspection + a DVIR in the app are required by the DOT for every shift (15 min minimum). Skipping it can put you out of service, raises our insurance, and hurts our safety scores. Correct process:

1. Open Samsara and certify any previous day's logs. (Certify ALL logs at end of shift.)
2. Assign yourself to the truck for the day.
3. Go "On Duty" and add the remark "Pre-Trip Inspection" (prompted, just select it).
4. Create a DVIR: select vehicle if bobtail, or vehicle + trailer if hooked to your box/chassis. Vehicle and location auto-populate.
5. Choose Pre- or Post-trip accordingly.
6. Take and submit your walkaround photos.
7. Go through the vehicle defects; note anything that needs fixing. (A proper pre-trip lasts 15 min.)
8. If safe and legal, mark "Safe to Drive"; if not, "Unsafe". Click next.
9. Certify and submit.
10. Add BOL or Load # as your shipping ID.

You'll get a message that all tasks are complete. Report any equipment issue so we can fix it; submitting a "safe" DVIR and then being placed out of service (e.g. a bald tire) will not be tolerated. Deviations have consequences, up to termination.

Questions? Ryan Andrews 773-765-8798. DRIVE SAFE!"""

# Email = saludo + lo que se marcó (unidad/issues) + el texto oficial + firma.
# Placeholders: {driver}, {date}, {issues}.
DEFAULT_BODY = (
    "Good Morning, {driver}\n\n"
    "This notice is regarding your DVIR for {date}. The following was flagged "
    "on your assigned unit(s):\n{issues}\n\n"
    + NOTICE_BODY
    + "\n\nSincerely,\nAdrian Ramirez\nSafety/Maintenance Dept."
)

_MONTHS = ["", "January", "February", "March", "April", "May", "June",
           "July", "August", "September", "October", "November", "December"]


def _format_date(label: str) -> str:
    """'6.1' -> 'June 1'. Si no se reconoce, devuelve la etiqueta tal cual."""
    parts = str(label).split(".")
    if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
        month, day = int(parts[0]), int(parts[1])
        if 1 <= month <= 12:
            return f"{_MONTHS[month]} {day}"
    return str(label)


def _first_name(name: str) -> str:
    """'Cedric Dorsey' -> 'Cedric'; 'PATRICK WELLS' -> 'Patrick'."""
    tokens = str(name or "").strip().split()
    if not tokens:
        return "there"
    first = tokens[0]
    return first[:1].upper() + first[1:].lower()


def _issues_en(reasons: list[dict]) -> str:
    """Lista de issues en ingles para el cuerpo del correo."""
    out = []
    for r in reasons:
        if r["type"] == "NO_DVIR":
            out.append(f"  - {r['unit']}: no DVIR completed")
        elif r["type"] == "MISSING":
            out.append(f"  - {r['inspection']} inspection: not logged on duty")
        else:  # SHORT
            out.append(f"  - {r['inspection']} inspection: only {r['detail']} "
                       "— under the 15 min minimum")
    return "\n".join(out)


_BODY_FONT = "Arial, Helvetica, sans-serif"


def _render_html(text: str) -> str:
    """Convierte el cuerpo de texto plano en HTML, poniendo en negrita el
    parrafo de contacto (Ryan Andrews). Preserva saltos y espacios con
    `white-space: pre-wrap`."""
    esc = _html.escape(text)
    bold = _html.escape(BOLD_PARAGRAPH)
    if bold in esc:
        esc = esc.replace(bold, f"<strong>{bold}</strong>")
    return (
        f'<div style="white-space:pre-wrap;font-family:{_BODY_FONT};'
        f'font-size:14px;line-height:1.45;color:#111">{esc}</div>'
    )


def render_email(notice: Notice, date_label: str,
                 subject_tpl: str = DEFAULT_SUBJECT,
                 body_tpl: str = DEFAULT_BODY) -> tuple[str, str, str]:
    """Devuelve (asunto, cuerpo_texto, cuerpo_html) para un aviso."""
    date = _format_date(date_label)
    ctx = {"driver": _first_name(notice.driver), "date": date,
           "issues": _issues_en(notice.reasons)}
    subject = subject_tpl.format(**ctx)
    text = body_tpl.format(**ctx)
    return subject, text, _render_html(text)


# --- SMS ---------------------------------------------------------------------
def render_sms(notice: Notice, date_label: str) -> str:
    """Cuerpo del SMS: saludo breve + la versión compacta (`SMS_NOTICE_BODY`)."""
    date = _format_date(date_label)
    issues = ", ".join(notice.units) or "DVIR pending"
    name = _first_name(notice.driver)
    return (f"Hi {name}, regarding your DVIR for {date} ({issues}):\n\n"
            + SMS_NOTICE_BODY)
