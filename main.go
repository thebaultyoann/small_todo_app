// Todolist locale : bibliothèque standard Go uniquement (aucune dépendance).
// Les données sont stockées dans un fichier JSON, écrit de façon atomique.
//
// Le dossier static/ et le fichier todolist.json sont lus dans un dossier fixe
// (C:\Logiciels\Todo par défaut), quel que soit l'emplacement de l'exécutable.
package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Dossier contenant static/ et todolist.json (modifiable avec l'option -dir).
const defaultDir = `C:\Logiciels\Todo`

// Couleurs de projet autorisées (les teintes sont définies dans le CSS).
var validColors = map[string]bool{"": true, "red": true, "orange": true, "yellow": true, "green": true, "teal": true, "blue": true, "purple": true, "pink": true, "gray": true}

const (
	defaultWidth = 380
	minWidth     = 220
	maxWidth     = 4000
	defaultTime  = "18:00" // heure appliquée quand une date est donnée sans heure
)

// ---------- Modèles ----------

type Task struct {
	ID    int64   `json:"id"`
	Title string  `json:"title"`
	DueAt *string `json:"due_at"` // "2006-01-02T15:04" (heure locale) ou null
	Done  bool    `json:"done"`
}

type Project struct {
	ID        int64  `json:"id"`
	Name      string `json:"name"`
	Width     int    `json:"width"`     // largeur en pixels
	Collapsed bool   `json:"collapsed"` // projet fermé
	Color     string `json:"color"`     // clé de la palette ("" = aucune)
	OwnRow    bool   `json:"own_row"`   // projet seul sur sa ligne (les suivants passent dessous)
	Tasks     []Task `json:"tasks"`     // l'ordre du tableau = l'ordre d'affichage
}

type fileData struct {
	NextID   int64      `json:"next_id"`
	Projects []*Project `json:"projects"` // l'ordre du tableau = l'ordre d'affichage
}

// ---------- Erreurs ----------

var errNotFound = errors.New("introuvable")

type errBadRequest string

func (e errBadRequest) Error() string { return string(e) }

// ---------- Stockage ----------

type Store struct {
	mu   sync.Mutex
	path string
	data fileData
}

func openStore(path string) (*Store, error) {
	s := &Store{path: path, data: fileData{NextID: 1, Projects: []*Project{}}}

	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(string(b)) != "" {
		if err := json.Unmarshal(b, &s.data); err != nil {
			return nil, fmt.Errorf("lecture de %s : %w", path, err)
		}
	}

	// Normalisation et garde-fou sur le compteur d'identifiants.
	if s.data.Projects == nil {
		s.data.Projects = []*Project{}
	}
	var maxID int64
	for _, p := range s.data.Projects {
		if p.Tasks == nil {
			p.Tasks = []Task{}
		}
		if p.Width == 0 {
			p.Width = defaultWidth
		}
		maxID = max(maxID, p.ID)
		for _, t := range p.Tasks {
			maxID = max(maxID, t.ID)
		}
	}
	if s.data.NextID <= maxID {
		s.data.NextID = maxID + 1
	}
	return s, nil
}

// save écrit le fichier via un fichier temporaire puis un renommage,
// pour ne jamais laisser un fichier à moitié écrit. Appeler avec s.mu verrouillé.
func (s *Store) save() error {
	b, err := json.MarshalIndent(s.data, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

func (s *Store) newID() int64 {
	id := s.data.NextID
	s.data.NextID++
	return id
}

func (s *Store) project(id int64) *Project {
	for _, p := range s.data.Projects {
		if p.ID == id {
			return p
		}
	}
	return nil
}

func (s *Store) findTask(id int64) (*Project, int) {
	for _, p := range s.data.Projects {
		for i, t := range p.Tasks {
			if t.ID == id {
				return p, i
			}
		}
	}
	return nil, -1
}

func (s *Store) List() []Project {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Project, 0, len(s.data.Projects))
	for _, p := range s.data.Projects {
		c := *p
		c.Tasks = append([]Task{}, p.Tasks...)
		out = append(out, c)
	}
	return out
}

func (s *Store) CreateProject(name string) (Project, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p := &Project{ID: s.newID(), Name: name, Width: defaultWidth, Tasks: []Task{}}
	s.data.Projects = append(s.data.Projects, p)
	return *p, s.save()
}

func (s *Store) UpdateProject(id int64, fields map[string]json.RawMessage) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	p := s.project(id)
	if p == nil {
		return errNotFound
	}

	// On valide tout avant d'appliquer, pour ne jamais modifier à moitié.
	name, width, collapsed, ownRow := p.Name, p.Width, p.Collapsed, p.OwnRow
	color := p.Color
	changed := 0

	if raw, ok := fields["name"]; ok {
		var v string
		if err := json.Unmarshal(raw, &v); err != nil || strings.TrimSpace(v) == "" {
			return errBadRequest("nom invalide")
		}
		name = strings.TrimSpace(v)
		changed++
	}
	if raw, ok := fields["width"]; ok {
		var v float64
		if err := json.Unmarshal(raw, &v); err != nil {
			return errBadRequest("largeur invalide")
		}
		width = int(min(max(v, minWidth), maxWidth))
		changed++
	}
	if raw, ok := fields["collapsed"]; ok {
		if err := json.Unmarshal(raw, &collapsed); err != nil {
			return errBadRequest("état invalide")
		}
		changed++
	}
	if raw, ok := fields["own_row"]; ok {
		if err := json.Unmarshal(raw, &ownRow); err != nil {
			return errBadRequest("disposition invalide")
		}
		changed++
	}
	if raw, ok := fields["color"]; ok {
		if err := json.Unmarshal(raw, &color); err != nil || !validColors[color] {
			return errBadRequest("couleur invalide")
		}
		changed++
	}
	if changed == 0 {
		return errBadRequest("rien à modifier")
	}

	p.Name, p.Width, p.Collapsed, p.OwnRow = name, width, collapsed, ownRow
	p.Color = color
	return s.save()
}

func (s *Store) DeleteProject(id int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, p := range s.data.Projects {
		if p.ID == id {
			s.data.Projects = append(s.data.Projects[:i], s.data.Projects[i+1:]...)
			return s.save()
		}
	}
	return errNotFound
}

// ReorderProjects place les projets dans l'ordre donné ; les identifiants
// inconnus sont ignorés et les projets non cités restent à la suite.
func (s *Store) ReorderProjects(ids []int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	rest := make(map[int64]*Project, len(s.data.Projects))
	for _, p := range s.data.Projects {
		rest[p.ID] = p
	}
	out := make([]*Project, 0, len(s.data.Projects))
	for _, id := range ids {
		if p, ok := rest[id]; ok {
			out = append(out, p)
			delete(rest, id)
		}
	}
	for _, p := range s.data.Projects {
		if _, ok := rest[p.ID]; ok {
			out = append(out, p)
		}
	}
	s.data.Projects = out
	return s.save()
}

func (s *Store) CreateTask(projectID int64, title string, due *string) (Task, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p := s.project(projectID)
	if p == nil {
		return Task{}, errNotFound
	}
	t := Task{ID: s.newID(), Title: title, DueAt: due}
	p.Tasks = append(p.Tasks, t)
	return t, s.save()
}

func (s *Store) UpdateTask(id int64, fields map[string]json.RawMessage) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, i := s.findTask(id)
	if p == nil {
		return errNotFound
	}

	t := p.Tasks[i]
	changed := 0

	if raw, ok := fields["title"]; ok {
		var v string
		if err := json.Unmarshal(raw, &v); err != nil || strings.TrimSpace(v) == "" {
			return errBadRequest("titre invalide")
		}
		t.Title = strings.TrimSpace(v)
		changed++
	}
	if raw, ok := fields["due_at"]; ok {
		var v *string
		if err := json.Unmarshal(raw, &v); err != nil {
			return errBadRequest("date invalide")
		}
		if v == nil {
			t.DueAt = nil
		} else {
			due, err := normalizeDue(*v)
			if err != nil {
				return err
			}
			t.DueAt = due
		}
		changed++
	}
	if raw, ok := fields["done"]; ok {
		if err := json.Unmarshal(raw, &t.Done); err != nil {
			return errBadRequest("état invalide")
		}
		changed++
	}
	if changed == 0 {
		return errBadRequest("rien à modifier")
	}

	p.Tasks[i] = t
	return s.save()
}

func (s *Store) DeleteTask(id int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, i := s.findTask(id)
	if p == nil {
		return errNotFound
	}
	p.Tasks = append(p.Tasks[:i], p.Tasks[i+1:]...)
	return s.save()
}

// ReorderTasks réordonne les tâches d'un projet. Les tâches non citées
// (par exemple les tâches terminées) gardent leur ordre et passent à la suite.
func (s *Store) ReorderTasks(projectID int64, ids []int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	p := s.project(projectID)
	if p == nil {
		return errNotFound
	}

	rest := make(map[int64]Task, len(p.Tasks))
	for _, t := range p.Tasks {
		rest[t.ID] = t
	}
	out := make([]Task, 0, len(p.Tasks))
	for _, id := range ids {
		if t, ok := rest[id]; ok {
			out = append(out, t)
			delete(rest, id)
		}
	}
	for _, t := range p.Tasks {
		if _, ok := rest[t.ID]; ok {
			out = append(out, t)
		}
	}
	p.Tasks = out
	return s.save()
}

// normalizeDue accepte "AAAA-MM-JJTHH:MM" ou "AAAA-MM-JJ" (heure fixée à 18:00).
func normalizeDue(s string) (*string, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, nil
	}
	if _, err := time.Parse("2006-01-02T15:04", s); err == nil {
		return &s, nil
	}
	if _, err := time.Parse("2006-01-02", s); err == nil {
		v := s + "T" + defaultTime
		return &v, nil
	}
	return nil, errBadRequest("date invalide (attendu : AAAA-MM-JJTHH:MM)")
}

// ---------- HTTP ----------

type API struct{ store *Store }

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, err error) {
	var bad errBadRequest
	switch {
	case errors.Is(err, errNotFound):
		http.Error(w, err.Error(), http.StatusNotFound)
	case errors.As(err, &bad):
		http.Error(w, bad.Error(), http.StatusBadRequest)
	default:
		log.Printf("erreur: %v", err)
		http.Error(w, "erreur interne", http.StatusInternalServerError)
	}
}

func readJSON(r *http.Request, dst any) error {
	r.Body = http.MaxBytesReader(nil, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(dst); err != nil {
		return errBadRequest("JSON invalide")
	}
	return nil
}

func pathID(r *http.Request) (int64, error) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		return 0, errBadRequest("identifiant invalide")
	}
	return id, nil
}

func noContent(w http.ResponseWriter, err error) {
	if err != nil {
		writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) routes(staticDir string) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /api/projects", a.listProjects)
	mux.HandleFunc("POST /api/projects", a.createProject)
	mux.HandleFunc("PUT /api/projects/order", a.reorderProjects)
	mux.HandleFunc("PATCH /api/projects/{id}", a.updateProject)
	mux.HandleFunc("DELETE /api/projects/{id}", a.deleteProject)

	mux.HandleFunc("POST /api/projects/{id}/tasks", a.createTask)
	mux.HandleFunc("PUT /api/projects/{id}/tasks/order", a.reorderTasks)
	mux.HandleFunc("PATCH /api/tasks/{id}", a.updateTask)
	mux.HandleFunc("DELETE /api/tasks/{id}", a.deleteTask)

	files := http.FileServer(http.Dir(staticDir))
	mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		files.ServeHTTP(w, r)
	})
	return mux
}

func (a *API) listProjects(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, a.store.List())
}

func (a *API) createProject(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Name string `json:"name"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, err)
		return
	}
	name := strings.TrimSpace(in.Name)
	if name == "" {
		writeErr(w, errBadRequest("le nom du projet est requis"))
		return
	}
	p, err := a.store.CreateProject(name)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, p)
}

func (a *API) updateProject(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	var fields map[string]json.RawMessage
	if err := readJSON(r, &fields); err != nil {
		writeErr(w, err)
		return
	}
	noContent(w, a.store.UpdateProject(id, fields))
}

func (a *API) deleteProject(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	noContent(w, a.store.DeleteProject(id))
}

func (a *API) reorderProjects(w http.ResponseWriter, r *http.Request) {
	var in struct {
		IDs []int64 `json:"ids"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, err)
		return
	}
	noContent(w, a.store.ReorderProjects(in.IDs))
}

func (a *API) createTask(w http.ResponseWriter, r *http.Request) {
	projectID, err := pathID(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	var in struct {
		Title string  `json:"title"`
		DueAt *string `json:"due_at"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, err)
		return
	}
	title := strings.TrimSpace(in.Title)
	if title == "" {
		writeErr(w, errBadRequest("le titre de la tâche est requis"))
		return
	}
	var due *string
	if in.DueAt != nil {
		if due, err = normalizeDue(*in.DueAt); err != nil {
			writeErr(w, err)
			return
		}
	}
	t, err := a.store.CreateTask(projectID, title, due)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, t)
}

func (a *API) reorderTasks(w http.ResponseWriter, r *http.Request) {
	projectID, err := pathID(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	var in struct {
		IDs []int64 `json:"ids"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, err)
		return
	}
	noContent(w, a.store.ReorderTasks(projectID, in.IDs))
}

func (a *API) updateTask(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	var fields map[string]json.RawMessage
	if err := readJSON(r, &fields); err != nil {
		writeErr(w, err)
		return
	}
	noContent(w, a.store.UpdateTask(id, fields))
}

func (a *API) deleteTask(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	noContent(w, a.store.DeleteTask(id))
}

// ---------- main ----------

func main() {
	// 127.0.0.1 : l'application n'est accessible que depuis cette machine.
	addr := flag.String("addr", "127.0.0.1:3333", "adresse d'écoute")
	dir := flag.String("dir", defaultDir, "dossier contenant static/ et todolist.json")
	flag.Parse()

	if err := os.MkdirAll(*dir, 0o755); err != nil {
		log.Fatalf("création du dossier %s : %v", *dir, err)
	}

	staticDir := filepath.Join(*dir, "static")
	if _, err := os.Stat(filepath.Join(staticDir, "index.html")); err != nil {
		log.Fatalf("dossier static introuvable : copiez-le dans %s (%v)", *dir, err)
	}

	dataPath := filepath.Join(*dir, "todolist.json")
	store, err := openStore(dataPath)
	if err != nil {
		log.Fatalf("ouverture des données : %v", err)
	}
	api := &API{store: store}

	log.Printf("Dossier : %s", *dir)
	log.Printf("Todolist disponible sur http://%s", *addr)
	log.Fatal(http.ListenAndServe(*addr, api.routes(staticDir)))
}
