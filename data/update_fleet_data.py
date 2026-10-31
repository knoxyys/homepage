# only run when fleetlists are updated (updates the json file)

import requests
import json
from bs4 import BeautifulSoup

operator_urls = {
    "Transit Systems": "https://fleetlists.busaustralia.com/tsa.php?search=TSA",
    "Busways": "https://fleetlists.busaustralia.com/bus.php?search=BUS",
    "CDC NSW": "https://fleetlists.busaustralia.com/cdc.php?search=CDC",
    "Keolis Downer": "https://fleetlists.busaustralia.com/kdn.php?search=KDN",
    "Transdev John Holland": "https://fleetlists.busaustralia.com/tdv.php?search=TDV",
    "U-Go Mobility": "https://fleetlists.busaustralia.com/nsw.php?search=UGO",
    "Maianbar Bundeena": "https://fleetlists.busaustralia.com/nsw.php?search=MAI",
    
    "Red Bus": "https://fleetlists.busaustralia.com/nsw.php?search=RED",
    "Port Stephens Coaches": "https://fleetlists.busaustralia.com/nsw.php?search=POR",
    "Rover Coaches": "https://fleetlists.busaustralia.com/nsw.php?search=ROV",
    "Premier Illawarra": "https://fleetlists.busaustralia.com/nsw.php?search=PRE",
    "Dions Bus Service": "https://fleetlists.busaustralia.com/nsw.php?search=DIO",
    
    "Picton Buslines": "https://fleetlists.busaustralia.com/nsw.php?search=PCN", # realtime script doesnt get non opal buses so
    
    "NSBC": "https://www.busaustralia.com/fleetlists/nsw.php?search=NOR",
}

bus_data = {}

def fetch_operator_data(operator_name, url):
    response = requests.get(url)
    if response.status_code != 200:
        print(f"Failed to fetch data for {operator_name}")
        return

    soup = BeautifulSoup(response.text, "html.parser")
    rows = soup.select("table#resultform tbody tr")
    current_rego = None

    def get_cell_text(cells, index):
        return cells[index].text.strip() if index < len(cells) else None

    for row in rows:
        cells = row.find_all("td")
        if len(cells) > 1:
            if operator not in ['Premier Illawarra', 'Dions Bus Service', 'NSBC']:
                fleet_no = get_cell_text(cells, 0)
                rego = get_cell_text(cells, 1)
                chassis = get_cell_text(cells, 2)
                vin = get_cell_text(cells, 3)
                body = get_cell_text(cells, 4)
                body_no = get_cell_text(cells, 5)
                body_date = get_cell_text(cells, 6)
                seating = get_cell_text(cells, 7)
                livery = get_cell_text(cells, 8)
                depot = get_cell_text(cells, 9)
            else:
                fleet_no = None
                rego = get_cell_text(cells, 0)
                chassis = get_cell_text(cells, 1)
                vin = get_cell_text(cells, 2)
                body = get_cell_text(cells, 3)
                body_no = get_cell_text(cells, 4)
                body_date = get_cell_text(cells, 5)
                seating = get_cell_text(cells, 6)
                livery = get_cell_text(cells, 7)
                depot = get_cell_text(cells, 8)
            if fleet_no in [None, '']: fleet_no = "?" + rego.strip("m/oMOTV ") # hash to indicate fabricated fleetno
                

            if rego:
                current_rego = rego
                bus_data[rego] = {
                    "fleet_no": fleet_no,
                    "rego": rego,
                    "chassis": chassis,
                    "vin": vin,
                    "body": body,
                    "body_no": body_no,
                    "body_date": body_date,
                    "seating": seating,
                    "livery": livery,
                    "depot": depot,
                    "operator": operator_name
                }
        elif len(cells) == 1 and current_rego:
            # Additional info row
            extra_info = cells[0].text.strip()
            bus_data[current_rego]["extra_info"] = extra_info

    print(f"Data fetched for {operator_name}")

# Fetch data for all operators
for operator, url in operator_urls.items():
    fetch_operator_data(operator, url)

# Save to JSON file
with open("data/bus_fleet_data.json", "w") as f:
    json.dump(bus_data, f, indent=4)

print("Data saved to bus_fleet_data.json")
