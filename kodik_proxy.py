from anime_parsers_ru import KodikSearch
from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

searcher = KodikSearch()

@app.route('/api/kodik/search')
def search():
    title = request.args.get('title', '')
    shikimori_id = request.args.get('shikimori_id', '')
    
    results = []
    
    try:
        if shikimori_id:
            print(f'Поиск по ID: {shikimori_id}')
            query = searcher.shikimori_id(shikimori_id).limit(10)
            data = query.execute()
            results = [dict(r.raw_data) for r in data.results]
        
        if not results and title:
            print(f'Поиск по названию: {title}')
            query = searcher.title(title).limit(10)
            data = query.execute()
            results = [dict(r.raw_data) for r in data.results]
            
        print(f'Найдено: {len(results)}')
    except Exception as e:
        print(f'Ошибка: {e}')
    
    return jsonify({"results": results})

if __name__ == '__main__':
    print('🚀 Kodik прокси на http://localhost:5000')
    app.run(host='0.0.0.0', port=5000)