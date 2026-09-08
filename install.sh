rm -rf ./.conda
conda create --prefix ./.conda python=3.11 -y
./.conda/bin/python -m pip install --upgrade pip
./.conda/bin/python -m pip install -r requirements.txt
