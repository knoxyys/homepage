import requests
import zipfile
import io
import os
import time

# --------------------------------------------------
# CONFIG
API_KEY = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJqdGkiOiI4dU9BcXRVOWhVSlI3TmdHd280WEtucU1md2N0NkNXTEVPaWtKUmx2X2VJIiwiaWF0IjoxNzI1ODA0NDMwfQ.iYBoCEEThloziXVpi95XMDu6h1C9k9iqnLjGgNxJQPU'
BASE_URL = "https://api.transport.nsw.gov.au/v1/gtfs/schedule"

AGENCIES = [ # expand this if needed!
    "GSBC001",
    "GSBC002",
    "GSBC003",
    "GSBC004",
    "SBSC006",
    "GSBC007",
    "GSBC008",
    "GSBC009",
    "GSBC010",
    "GSBC014",

    "OSMBSC001",
    "OSMBSC002",
    "OSMBSC003",
    "OSMBSC004",
    "OSMBSC006",
    "OSMBSC007",
    "OSMBSC008",
    "OSMBSC009",
    "OSMBSC010",
    "OSMBSC011",
    "OSMBSC012",

    "NISC001",
]





# --------------------------------------------------
# DOWNLOAD

def download_bus_schedule(agency_id):
    OUTPUT_DIR = f"./data/agency_data/{agency_id}"
    url = f"{BASE_URL}/buses/{agency_id}"
    headers = {
        "Authorization": f"apikey {API_KEY}",
        "Accept": "application/octet-stream"
    }

    print(f"Requesting data for {agency_id}...")
    
    try:
        # 1. Perform the GET request
        response = requests.get(url, headers=headers, stream=True)
        
        # Check for authentication or other errors
        if response.status_code == 401:
            print("Error: Unauthorized. Check your API Key.")
            return
        elif response.status_code != 200:
            print(f"Error: Received status code {response.status_code}")
            return

        # 2. Load the ZIP content into memory
        print("Download complete. Extracting files...")
        with zipfile.ZipFile(io.BytesIO(response.content)) as z:
            if not os.path.exists(OUTPUT_DIR):
                os.makedirs(OUTPUT_DIR)
            
            # 3. Extract all CSV/TXT files
            z.extractall(path=OUTPUT_DIR)
            print(f"Success! Files extracted to: {os.path.abspath(OUTPUT_DIR)}")
            
            # List files found
            print("Files found:", z.namelist())

    except Exception as e:
        print(f"An error occurred: {e}")

# --------------------------------------------------
# RUN

if __name__ == "__main__":
    for agency in AGENCIES:
        download_bus_schedule(agency)
        time.sleep(1.5) # just in case tfnsw doesn't like that many api downloads at once
