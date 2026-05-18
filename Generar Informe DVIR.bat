@echo off
cd /d "%~dp0"
py -c "import pandas, openpyxl" 2>nul || py -m pip install pandas openpyxl
start "" pyw dvir_report.py
