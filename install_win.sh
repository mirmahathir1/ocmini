rm -rf ./.conda
conda create --prefix ./env python=3.11 -y
./env/python.exe -m pip install --upgrade pip
./env/python.exe -m pip install -r requirements.txt
