rm -rf ./.conda
conda create --prefix ./.conda python=3.11 -y
./.conda/python.exe -m pip install --upgrade pip
./.conda/python.exe -m pip install -r requirements.txt
