rm -rf ./.conda
conda create --prefix ./env python=3.11 -y
./env/bin/python -m pip install --upgrade pip
./env/bin/python -m pip install -r requirements.txt
